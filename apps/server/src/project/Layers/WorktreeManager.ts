import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  CommandId,
  EventId,
  type ThreadId,
  type WorktreesInspectInput,
  type WorktreesInspectResult,
} from "@t3tools/contracts";
import { Deferred, Effect, FileSystem, Layer, Option } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import {
  evaluateWorktreeRemoval,
  removeWorktreeSafely,
  stopDeletedWorktreeClaims,
  stopWorktreeSession,
} from "../worktreeClaims.ts";
import { readWorktreeState } from "../worktreeReadiness.ts";
import { WorktreeManager, type WorktreeManagerShape } from "../Services/WorktreeManager.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import {
  pathContains,
  withWorktreeLifecycleLock,
  withWorktreeLifecycleLocks,
} from "./WorktreeLifecycleCoordinator.ts";

export const makeWorktreeManager = Effect.gen(function* () {
  const services = yield* Effect.services<
    | GitCore
    | ServerConfig
    | OrchestrationEngineService
    | NextTurnQueueStore
    | TerminalManager
    | ProviderService
    | WorktreeSetupGate
  >();
  const git = yield* GitCore;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const queue = yield* NextTurnQueueStore;
  const setup = yield* WorktreeSetupGate;
  const dispatcher = yield* NextTurnQueueDispatcher;
  const preparation = yield* WorktreePreparation;
  const turns = yield* ProjectionTurnRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const activeRecoveries = new Map<
    ThreadId,
    { token: string; cancel: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
  >();
  const canonical = (path: string) => Effect.tryPromise(() => canonicalWorktreePath(path));
  const projectFor = (id: WorktreesInspectInput["projectId"]) =>
    Effect.gen(function* () {
      const project = (yield* engine.getReadModel()).projects.find(
        (entry) => entry.id === id && entry.deletedAt === null,
      );
      if (!project) return yield* Effect.fail(new Error("Unknown project"));
      return project;
    });
  const context = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      if (!thread) return yield* Effect.fail(new Error("Unknown conversation"));
      return { thread, project: yield* projectFor(thread.projectId) };
    });
  const inspectBranch = (
    project: { workspaceRoot: string },
    path: string,
    branch: string | null,
    headSha: string | null,
    allowTargetCheckout = true,
  ) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      let branchExists = false,
        branchMerged = false,
        branchPushed = false,
        branchUpstreamGone = false;
      let branchBlockedReason: string | null = "No branch is registered.";
      if (branch) {
        branchExists = yield* git.branchExists(project.workspaceRoot, branch);
        const defaultBranch = yield* git.readDefaultBranch(project.workspaceRoot);
        const remotes = yield* git.listRemotes(project.workspaceRoot);
        const primaryRemote =
          remotes.find((remote) => remote.name === "origin")?.name ?? remotes[0]?.name;
        const defaultShas = defaultBranch
          ? [
              yield* git.resolveCommit(project.workspaceRoot, `refs/heads/${defaultBranch}`),
              primaryRemote
                ? yield* git.resolveCommit(
                    project.workspaceRoot,
                    `refs/remotes/${primaryRemote}/${defaultBranch}`,
                  )
                : null,
            ]
          : [];
        for (const sha of defaultShas)
          if (headSha && sha && (yield* git.isAncestor(project.workspaceRoot, headSha, sha)))
            branchMerged = true;
        const remote = yield* git.readConfigValue(project.workspaceRoot, `branch.${branch}.remote`);
        const merge = yield* git.readConfigValue(project.workspaceRoot, `branch.${branch}.merge`);
        const upstream =
          remote && merge
            ? remote === "."
              ? merge
              : `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, "")}`
            : null;
        const upstreamSha = upstream
          ? yield* git.resolveCommit(project.workspaceRoot, upstream)
          : null;
        branchUpstreamGone = upstream !== null && upstreamSha === null;
        branchPushed =
          headSha !== null &&
          upstreamSha !== null &&
          (yield* git.isAncestor(project.workspaceRoot, headSha, upstreamSha));
        const target = yield* canonical(path);
        const checkedOutElsewhere = (yield* git.listWorktrees(project.workspaceRoot)).some(
          (entry) =>
            entry.branch === branch && (!allowTargetCheckout || entry.canonicalPath !== target),
        );
        const common = yield* canonical(yield* git.resolveCommonDir(project.workspaceRoot));
        const repositories = new Map<string, string | null>();
        let linked = false;
        for (const thread of model.threads) {
          if (thread.deletedAt !== null) continue;
          const owner = model.projects.find((entry) => entry.id === thread.projectId);
          const workspace = thread.worktreePath ?? owner?.workspaceRoot;
          // Unknown references remain fail-closed, but equal branch names in other
          // repositories do not protect this repository's ref.
          if (!workspace || (yield* canonical(workspace)) === target) linked = true;
          if (thread.branch !== branch) continue;
          if (!owner) {
            linked = true;
            continue;
          }
          if (!repositories.has(owner.workspaceRoot))
            repositories.set(
              owner.workspaceRoot,
              yield* git.resolveCommonDir(owner.workspaceRoot).pipe(
                Effect.flatMap(canonical),
                Effect.orElseSucceed(() => null),
              ),
            );
          const ownerCommon = repositories.get(owner.workspaceRoot);
          if (!ownerCommon || ownerCommon === common) linked = true;
        }
        branchBlockedReason = !branchExists
          ? "Branch no longer exists."
          : !defaultBranch
            ? "Default branch is unknown."
            : branch === defaultBranch
              ? "The default branch is protected."
              : checkedOutElsewhere
                ? "Branch is checked out elsewhere."
                : linked
                  ? "A conversation still references this branch or checkout."
                  : !(branchMerged || branchPushed)
                    ? "Branch has commits that are neither merged nor pushed."
                    : null;
      }
      return {
        branchExists,
        branchMerged,
        branchPushed,
        branchUpstreamGone,
        branchDeletable: branchBlockedReason === null,
        branchBlockedReason,
      };
    });
  const inspect: WorktreeManagerShape["inspect"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const gate = yield* evaluateWorktreeRemoval({
        projectCwd: project.workspaceRoot,
        path: input.path,
        policy: { kind: "manual", ownThreadId: null },
      }).pipe(Effect.provideServices(services));
      const branch = gate.registration?.branch ?? null;
      const headSha = gate.registration?.headSha ?? null;
      const model = yield* engine.getReadModel();
      const linkedThreads = model.threads
        .filter((thread) => gate.linkedThreads.includes(thread.id))
        .map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          archived: thread.archivedAt !== null,
        }));
      const facts = yield* inspectBranch(project, input.path, branch, headSha);
      return {
        ...gate,
        linkedThreads,
        branch,
        headSha,
        ...facts,
      } satisfies WorktreesInspectResult;
    });
  const stopIdleSession = (threadId: ThreadId) =>
    stopWorktreeSession(threadId).pipe(Effect.provideServices(services));
  const remove: WorktreeManagerShape["remove"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const preview = yield* inspect(input);
      if (preview.blockedReasons.length)
        return { removed: false, branchDeleted: false, blockedReasons: preview.blockedReasons };
      yield* stopDeletedWorktreeClaims(preview.deletedThreadClaims).pipe(
        Effect.provideServices(services),
      );
      let branchDeleted = false;
      const branchReasons: string[] = [];
      const checked = yield* removeWorktreeSafely({
        projectCwd: project.workspaceRoot,
        path: input.path,
        policy: { kind: "manual", ownThreadId: null },
        expectedHead: input.expectedHead,
        afterRemoval: (registration) =>
          Effect.gen(function* () {
            if (!input.deleteBranch || !registration?.branch || !registration.headSha) return;
            const facts = yield* inspectBranch(
              project,
              input.path,
              registration.branch,
              registration.headSha,
              false,
            );
            if (!facts.branchDeletable) {
              branchReasons.push(facts.branchBlockedReason ?? "Branch could not be verified.");
              return;
            }
            branchDeleted = yield* git.deleteBranchIfAt({
              cwd: project.workspaceRoot,
              branch: registration.branch,
              expectedSha: registration.headSha,
            });
            if (!branchDeleted) branchReasons.push("Branch moved; it was retained.");
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                branchReasons.push(`Branch retained: ${error.message}`);
              }),
            ),
          ),
      }).pipe(Effect.provideServices(services));
      return {
        removed: checked.blockedReasons.length === 0,
        branchDeleted,
        blockedReasons: [...checked.blockedReasons, ...branchReasons],
      };
    });
  const threadState: WorktreeManagerShape["threadState"] = (input) =>
    Effect.gen(function* () {
      const { thread, project } = yield* context(input.threadId);
      const state =
        thread.worktreePath !== null
          ? yield* readWorktreeState(git, {
              projectCwd: project.workspaceRoot,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            })
          : {
              worktreePath: null,
              branch: thread.branch,
              directoryExists: yield* fileSystem.exists(project.workspaceRoot),
              registration: "none" as const,
              branchExists: false,
              defaultBranch: null,
            };
      const data = yield* queue.listByThread(thread.id);
      const token = data.state.worktreeBlockToken;
      const recovery = token?.startsWith("recovery:")
        ? (yield* setup.check(thread.id, token)) === "gating"
          ? "running"
          : "interrupted"
        : "none";
      return { ...state, recovery } as const;
    });
  const recover: WorktreeManagerShape["recover"] = (input) =>
    Effect.gen(function* () {
      const initial = yield* context(input.threadId);
      if (input.action === "cancel") {
        const active = activeRecoveries.get(input.threadId);
        const data = yield* queue.listByThread(input.threadId);
        if (
          !active ||
          data.state.worktreeBlockToken !== active.token ||
          data.state.revision !== input.expectedQueueRevision
        )
          return yield* Effect.fail(new Error("Recovery changed. Refresh and try again."));
        yield* Deferred.succeed(active.cancel, undefined);
        yield* Deferred.await(active.done);
        return yield* threadState(input);
      }
      const token = `recovery:${crypto.randomUUID()}`;
      let reserved = false;
      if (!initial.thread.worktreePath && input.action !== "useProjectCheckout")
        return yield* Effect.fail(
          new Error("This conversation already uses the project checkout."),
        );
      const check = Effect.gen(function* () {
        const { thread, project } = yield* context(input.threadId);
        const data = yield* queue.listByThread(thread.id);
        if (
          reserved
            ? data.state.worktreeBlockToken !== token
            : data.state.revision !== input.expectedQueueRevision
        )
          return yield* Effect.fail(new Error("The queue changed. Refresh and try again."));
        if (
          Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId: thread.id })) ||
          thread.session?.activeTurnId ||
          thread.session?.status === "running" ||
          thread.session?.status === "starting" ||
          data.items.some((item) => item.status === "dispatching")
        )
          return yield* Effect.fail(new Error("Wait for the active turn to finish."));
        const setupState = yield* setup.check(thread.id, data.state.worktreeBlockToken);
        if (
          (setupState === "gating" && !reserved) ||
          (setupState === "orphaned" && !data.state.worktreeBlockToken?.startsWith("recovery:"))
        )
          return yield* Effect.fail(new Error("Workspace setup is already in progress."));
        return { thread, project, data };
      });
      const beforeRecovery = yield* check;
      const retryingRecovery =
        beforeRecovery.data.state.worktreeBlockToken?.startsWith("recovery:") === true;
      const path = initial.thread.worktreePath ?? initial.project.workspaceRoot;
      const plannedState = input.action === "recreateFromBase" ? yield* threadState(input) : null;
      const plannedBranch =
        input.action === "recreateFromBase"
          ? initial.thread.branch && !plannedState?.branchExists
            ? initial.thread.branch
            : `t3code/${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
          : null;
      const managed = yield* canonical(config.worktreesDir);
      const old = initial.thread.worktreePath
        ? yield* canonical(initial.thread.worktreePath)
        : null;
      const destination = plannedBranch
        ? old && old !== managed && pathContains(managed, old) && !plannedState?.directoryExists
          ? initial.thread.worktreePath!
          : yield* git.allocateWorktreePath({
              cwd: initial.project.workspaceRoot,
              branch: plannedBranch,
            })
        : path;
      const cancellation = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      let prepared: { path: string; project: typeof initial.project } | null = null;
      return yield* Effect.gen(function* () {
        yield* withWorktreeLifecycleLocks(
          [path, destination],
          Effect.gen(function* () {
            const { thread } = yield* check;
            if (
              thread.worktreePath !== initial.thread.worktreePath ||
              thread.branch !== initial.thread.branch
            )
              return yield* Effect.fail(new Error("The workspace changed. Refresh and try again."));
            yield* setup.register(thread.id, token);
            yield* queue.setWorktreeBlockToken({ threadId: thread.id, token });
            reserved = true;
            activeRecoveries.set(thread.id, { token, cancel: cancellation, done });
            // Serialize behind prior acceptance before deciding whether an idle session can stop.
            const createdAt = new Date().toISOString();
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`${token}:reserved`),
              threadId: thread.id,
              activity: {
                id: EventId.makeUnsafe(`${token}:reserved`),
                tone: "info",
                kind: "worktree.recovery",
                summary: "Recovering workspace",
                payload: { operationId: token, phase: "reserved" },
                turnId: null,
                createdAt,
              },
              createdAt,
            });
            yield* check;
          }),
        );
        yield* stopIdleSession(input.threadId);
        yield* withWorktreeLifecycleLocks(
          [path, destination],
          Effect.gen(function* () {
            const { thread, project } = yield* check;
            if (
              thread.worktreePath !== initial.thread.worktreePath ||
              thread.branch !== initial.thread.branch
            )
              return yield* Effect.fail(new Error("The workspace changed. Refresh and try again."));
            if (input.action === "useProjectCheckout") {
              const root = yield* git.inspectCheckoutIdentity(project.workspaceRoot);
              yield* engine.dispatch({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe(token),
                threadId: thread.id,
                branch: root.branch,
                worktreePath: null,
              });
              return;
            }
            const state = yield* threadState(input);
            if (input.action === "recreate") {
              if (!state.branchExists || !thread.worktreePath || !thread.branch)
                return yield* Effect.fail(
                  new Error("The branch is missing. Recreate from the default branch instead."),
                );
              yield* git.ensureWorktree({
                owner: `thread:${thread.id}`,
                cwd: project.workspaceRoot,
                path: thread.worktreePath,
                branch: thread.branch,
                submodules: "none",
              });
              prepared = { path: thread.worktreePath, project };
            } else {
              const base = state.defaultBranch;
              if (!base) return yield* Effect.fail(new Error("No base branch is available."));
              const branch = plannedBranch!;
              const target = destination;
              yield* withWorktreeLifecycleLock(
                target,
                Effect.gen(function* () {
                  yield* git.clearMissingRegistration(project.workspaceRoot, target);
                  const baseSha = yield* git.resolveCommit(project.workspaceRoot, base);
                  if (!baseSha)
                    return yield* Effect.fail(new Error("The recovery base no longer exists."));
                  // A durable ownership record precedes checkout. Release 2 consolidates these
                  // preparation records into the shared preparation repository.
                  yield* engine.dispatch({
                    type: "thread.activity.append",
                    commandId: CommandId.makeUnsafe(`${token}:allocated`),
                    threadId: thread.id,
                    activity: {
                      id: EventId.makeUnsafe(token),
                      tone: "info",
                      kind: "worktree.recovery",
                      summary: "Preparing recovered worktree",
                      payload: {
                        operationId: token,
                        worktreePath: target,
                        branch,
                        baseSha,
                        commonDir: yield* git.resolveCommonDir(project.workspaceRoot),
                        phase: "allocated",
                      },
                      turnId: null,
                      createdAt: new Date().toISOString(),
                    },
                    createdAt: new Date().toISOString(),
                  });
                  const created = yield* git.createWorktree({
                    preparation: {
                      owner: `thread:${thread.id}`,
                      runSetupScript: true,
                      replaceMissing: true,
                    },
                    cwd: project.workspaceRoot,
                    branch: base,
                    baseRefName: baseSha,
                    newBranch: branch,
                    path: target,
                    submodules: "none",
                  });
                  yield* engine.dispatch({
                    type: "thread.meta.update",
                    commandId: CommandId.makeUnsafe(token),
                    threadId: thread.id,
                    branch: created.worktree.branch,
                    worktreePath: created.worktree.path,
                  });
                  prepared = { path: created.worktree.path, project };
                }),
              );
            }
          }),
        );
        // Scripts run with the durable queue barrier set and no lifecycle lock held.
        if (prepared !== null) {
          const workspace = prepared as { path: string; project: typeof initial.project };
          const current = (yield* context(input.threadId)).thread;
          if (!current.branch)
            return yield* Effect.fail(new Error("The recovered branch is unavailable."));
          yield* preparation
            .prepare({
              threadId: input.threadId,
              projectId: workspace.project.id,
              worktreePath: workspace.path,
              branch: current.branch,
              retry: true,
            })
            .pipe(
              Effect.timeout("10 minutes"),
              Effect.raceFirst(
                Deferred.await(cancellation).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new Error("Worktree preparation was cancelled. Retry recovery when ready."),
                    ),
                  ),
                ),
              ),
              Effect.tapError((error) => {
                const createdAt = new Date().toISOString();
                return engine
                  .dispatch({
                    type: "thread.activity.append",
                    commandId: CommandId.makeUnsafe(`${token}:failed`),
                    threadId: input.threadId,
                    activity: {
                      id: EventId.makeUnsafe(`${token}:failed`),
                      tone: "error",
                      kind: "worktree.recovery",
                      summary: `Recovery stopped: ${error.message}`,
                      payload: { operationId: token },
                      turnId: null,
                      createdAt,
                    },
                    createdAt,
                  })
                  .pipe(Effect.ignore);
              }),
            );
        }
        yield* setup.open(input.threadId, token);
        yield* queue.setWorktreeBlockToken({
          threadId: input.threadId,
          token: null,
          expectedToken: token,
        });
        yield* setup.unregister(input.threadId, token);
        const data = yield* queue.listByThread(input.threadId);
        if (
          data.state.paused &&
          (data.state.pauseReasonCode === "worktree_missing" ||
            (retryingRecovery && data.state.pauseReasonCode === "worktree_setup_failed"))
        )
          yield* queue.setPaused({
            threadId: input.threadId,
            paused: false,
            expectedRevision: data.state.revision,
          });
        yield* dispatcher.notify(input.threadId);
        return yield* threadState(input);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* setup.unregister(input.threadId, token);
            if (activeRecoveries.get(input.threadId)?.token === token)
              activeRecoveries.delete(input.threadId);
            yield* Deferred.succeed(done, undefined);
          }),
        ),
      );
    });
  return { inspect, remove, threadState, recover } satisfies WorktreeManagerShape;
});
export const WorktreeManagerLive = Layer.effect(WorktreeManager, makeWorktreeManager);
