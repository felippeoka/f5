import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  CommandId,
  EventId,
  type ThreadId,
  type WorktreesInspectInput,
  type WorktreesInspectResult,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import { Effect, Layer, Option } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath, resolveDefaultWorktreePath } from "../../git/worktreePaths.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { startOwnedSetupScript } from "../ownedSetupScript.ts";
import { readProjectSettings } from "../projectSettings.ts";
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
  const settings = yield* ServerSettingsService;
  const turns = yield* ProjectionTurnRepository;
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
      const state = yield* readWorktreeState(git, {
        projectCwd: project.workspaceRoot,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
      });
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
      if (!initial.thread.worktreePath && input.action !== "useProjectCheckout")
        return yield* Effect.fail(
          new Error("This conversation already uses the project checkout."),
        );
      const check = Effect.gen(function* () {
        const { thread, project } = yield* context(input.threadId);
        const data = yield* queue.listByThread(thread.id);
        if (data.state.revision !== input.expectedQueueRevision)
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
          setupState === "gating" ||
          (setupState === "orphaned" && !data.state.worktreeBlockToken?.startsWith("recovery:"))
        )
          return yield* Effect.fail(new Error("Workspace setup is already in progress."));
        return { thread, project, data };
      });
      const beforeRecovery = yield* check;
      const retryingRecovery =
        beforeRecovery.data.state.worktreeBlockToken?.startsWith("recovery:") === true;
      yield* stopIdleSession(input.threadId);
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
          : resolveDefaultWorktreePath({
              worktreesDir: config.worktreesDir,
              cwd: initial.project.workspaceRoot,
              branch: plannedBranch,
            })
        : path;
      const token = `recovery:${crypto.randomUUID()}`;
      let prepared: { path: string; project: typeof initial.project } | null = null;
      return yield* Effect.gen(function* () {
        yield* withWorktreeLifecycleLocks(
          [path, destination],
          Effect.gen(function* () {
            const { thread, project } = yield* check;
            if (
              thread.worktreePath !== initial.thread.worktreePath ||
              thread.branch !== initial.thread.branch
            )
              return yield* Effect.fail(new Error("The workspace changed. Refresh and try again."));
            yield* setup.register(thread.id, token);
            yield* queue.setWorktreeBlockToken({ threadId: thread.id, token });
            if (input.action === "useProjectCheckout") {
              const root = yield* git.inspectCheckout(project.workspaceRoot);
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
          const submodules = (yield* readProjectSettings(
            yield* settings.getSettings,
            workspace.project,
          )).settings.worktreeSubmodules;
          yield* git.initializeWorktreeSubmodules(workspace.path, submodules);
          const script = setupProjectScript(workspace.project.scripts);
          let setupError: string | null = null;
          if (script)
            yield* Effect.scoped(
              Effect.gen(function* () {
                const owned = yield* Effect.acquireRelease(
                  startOwnedSetupScript({
                    command: script.command,
                    cwd: workspace.path,
                    env: projectScriptRuntimeEnv({
                      project: { cwd: workspace.project.workspaceRoot },
                      worktreePath: workspace.path,
                    }),
                    onLine: () => {},
                  }),
                  (process) => process.kill,
                );
                const code = yield* owned.exit;
                if (code !== 0) {
                  setupError = `Setup script exited with code ${code}.`;
                  yield* Effect.logWarning("worktree recovery setup script failed", {
                    threadId: input.threadId,
                    code,
                  });
                }
              }),
            );
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`${token}:prepared`),
            threadId: input.threadId,
            activity: {
              id: EventId.makeUnsafe(`worktree-prepared:${input.threadId}`),
              tone: setupError ? "error" : "info",
              kind: "worktree.prepared",
              summary: setupError ? `Worktree recreated; ${setupError}` : "Worktree prepared",
              payload: { worktreePath: workspace.path, operationId: token, error: setupError },
              turnId: null,
              createdAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          });
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
      }).pipe(Effect.ensuring(setup.unregister(input.threadId, token)));
    });
  return { inspect, remove, threadState, recover } satisfies WorktreeManagerShape;
});
export const WorktreeManagerLive = Layer.effect(WorktreeManager, makeWorktreeManager);
