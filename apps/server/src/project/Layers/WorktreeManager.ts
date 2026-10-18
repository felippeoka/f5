import { listWorktreeInventory } from "../worktreeInventory.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import {
  type ThreadId,
  type WorktreesInspectInput,
  type WorktreesInspectResult,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option } from "effect";
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
} from "../worktreeClaims.ts";
import { readWorktreeState } from "../worktreeReadiness.ts";
import { WorktreeManager, type WorktreeManagerShape } from "../Services/WorktreeManager.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";

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
  const transitions = yield* Effect.serviceOption(WorkspaceTransition);
  const dispatcher = yield* NextTurnQueueDispatcher;
  const fileSystem = yield* FileSystem.FileSystem;
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
      const receipt =
        token === null && thread.worktreePath
          ? yield* git.readWorktreePreparation(thread.worktreePath)
          : null;
      const preparationInterrupted =
        receipt !== null &&
        ["allocated", "setup_failed", "setup_indeterminate"].includes(receipt.phase);
      const transition = Option.isSome(transitions)
        ? yield* transitions.value.getTransition(input)
        : null;
      const recovery =
        transition &&
        ["reserved", "stopping", "applying", "applied", "needs_recovery"].includes(transition.phase)
          ? transition.phase === "needs_recovery"
            ? "interrupted"
            : "running"
          : token?.startsWith("recovery:") || token?.startsWith("preparation:")
            ? (yield* setup.check(thread.id, token)) === "gating"
              ? "running"
              : "interrupted"
            : preparationInterrupted
              ? "interrupted"
              : "none";
      return { ...state, recovery } as const;
    });
  const recover: WorktreeManagerShape["recover"] = (input) =>
    Effect.gen(function* () {
      if (Option.isNone(transitions))
        return yield* Effect.fail(new Error("Workspace transitions are unavailable."));
      const { thread } = yield* context(input.threadId);
      const data = yield* queue.listByThread(thread.id);
      if (data.state.revision !== input.expectedQueueRevision)
        return yield* Effect.fail(new Error("The queue changed. Refresh and try again."));
      if (input.action === "cancel") {
        yield* transitions.value.cancel(thread.id, true);
        return yield* threadState(input);
      }
      const orphanedOwner =
        data.state.worktreeBlockToken &&
        (data.state.worktreeBlockToken.startsWith("recovery:") ||
          data.state.worktreeBlockToken.startsWith("preparation:")) &&
        (yield* setup.check(thread.id, data.state.worktreeBlockToken)) === "orphaned"
          ? data.state.worktreeBlockToken
          : undefined;
      const result = yield* transitions.value.switchWorkspace(
        {
          operationId: crypto.randomUUID(),
          threadId: thread.id,
          expected: {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            sessionUpdatedAt: thread.session?.updatedAt ?? null,
          },
          intent:
            input.action === "recreateFromBase"
              ? "recreate_from_base"
              : input.action === "useProjectCheckout"
                ? "use_project_checkout"
                : "recreate",
        },
        orphanedOwner,
      );
      if (result.phase !== "completed")
        return yield* Effect.fail(
          new Error(result.error ?? "Inspect and resolve the workspace transition."),
        );
      if (orphanedOwner)
        yield* queue.setWorktreeBlockToken({
          threadId: thread.id,
          token: null,
          expectedToken: orphanedOwner,
        });
      const latest = yield* queue.listByThread(thread.id);
      if (latest.state.paused && latest.state.pauseReasonCode === "worktree_missing")
        yield* queue.setPaused({
          threadId: thread.id,
          paused: false,
          expectedRevision: latest.state.revision,
        });
      yield* dispatcher.notify(thread.id);
      return yield* threadState(input);
    });
  const list: WorktreeManagerShape["list"] = (input) =>
    engine
      .getReadModel()
      .pipe(
        Effect.flatMap((model) => listWorktreeInventory(input, model, git, config, fileSystem)),
      );
  return { list, inspect, remove, threadState, recover } satisfies WorktreeManagerShape;
});
export const WorktreeManagerLive = Layer.effect(WorktreeManager, makeWorktreeManager);
