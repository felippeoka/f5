import { GitCommandError } from "../../git/Errors.ts";
import { lstat } from "node:fs/promises";
import { canonicalJsonHash } from "../../canonicalJsonHash.ts";
import { randomBytes } from "node:crypto";
import {
  CommandId,
  type ThreadId,
  type WorkspaceCheckoutIdentity,
  type WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { Cause, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore, type CheckoutInspection } from "../../git/Services/GitCore.ts";
import {
  WorkspaceTransitions,
  WorkspaceTransitionError,
  workspaceTransitionSnapshot,
  transitionIsActive,
  type WorkspaceTransitionRecord,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { assertExclusiveProfileCheckout } from "../../profiles/RepositorySharing.ts";
import { readWorktreeClaims } from "../worktreeClaims.ts";
import { canonicalWorkspace, inspectAttachableWorkspace } from "../workspaceAttachment.ts";
import { WorkspaceWriteContext } from "../workspaceTransitionContext.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import {
  WorkspaceTransition,
  type WorkspaceTransitionShape,
} from "../Services/WorkspaceTransition.ts";
import {
  withWorktreeLifecycleLock,
  withWorktreeLifecycleLocks,
  withRepositoryLifecycleLock,
  pathContains,
} from "./WorktreeLifecycleCoordinator.ts";

const digest = canonicalJsonHash;
const identity = (checkout: CheckoutInspection): WorkspaceCheckoutIdentity => ({
  path: checkout.canonicalRoot,
  repository: checkout.commonDir,
  branch: checkout.branch,
  headSha: checkout.headSha,
});
export const makeWorkspaceTransition = Effect.gen(function* () {
  const store = yield* WorkspaceTransitions;
  const engine = yield* OrchestrationEngineService;
  const git = yield* GitCore;
  const config = yield* ServerConfig;
  const queue = yield* NextTurnQueueStore;
  const dispatcher = yield* NextTurnQueueDispatcher;
  const setup = yield* WorktreeSetupGate;
  const preparation = yield* WorktreePreparation;
  const providers = yield* ProviderService;
  const services = yield* Effect.services<
    | OrchestrationEngineService
    | ProviderService
    | TerminalManager
    | NextTurnQueueStore
    | WorktreeSetupGate
  >();
  const scope = yield* Effect.scope;
  const secret = randomBytes(32).toString("hex");
  const workers = new Map<
    string,
    {
      fiber: Fiber.Fiber<void, never>;
      result: Deferred.Deferred<WorkspaceTransitionSnapshot, Error>;
    }
  >();
  const owners = new Map<string, number>();
  const withOwner = <A, E, R>(operationId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        owners.set(operationId, (owners.get(operationId) ?? 0) + 1);
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          const count = (owners.get(operationId) ?? 1) - 1;
          if (count === 0) owners.delete(operationId);
          else owners.set(operationId, count);
        }),
    );
  const readTransition = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const record = yield* store.forThread(threadId);
      if (
        record &&
        transitionIsActive(record) &&
        record.phase !== "needs_recovery" &&
        !workers.has(record.operationId) &&
        !owners.has(record.operationId)
      ) {
        const interrupted = yield* store.update(record, {
          phase: "needs_recovery",
          error: "Workspace switching stopped before completion. Inspect it before continuing.",
        });
        yield* dispatcher.notify(threadId);
        return interrupted;
      }
      return record;
    });
  const context = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const thread = model.threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null && entry.archivedAt === null,
      );
      const project = model.projects.find(
        (entry) => entry.id === thread?.projectId && entry.deletedAt === null,
      );
      if (!thread || !project)
        return yield* Effect.fail(new Error("Conversation or project is unavailable."));
      return { thread, project };
    });
  const currentRecord = (operationId: string) =>
    Effect.gen(function* () {
      const record = yield* store.get(operationId);
      if (!record) return yield* Effect.fail(new Error("Unknown workspace transition."));
      return record;
    });
  const inspect = (path: string) => git.inspectCheckout(path);
  const claims = (path: string) => readWorktreeClaims(path).pipe(Effect.provideServices(services));
  const validateClaims = (record: WorkspaceTransitionRecord, path: string, inPlace: boolean) =>
    Effect.gen(function* () {
      const usage = yield* claims(path);
      if (usage.unknown)
        return yield* Effect.fail(new Error("Workspace usage could not be verified."));
      const foreign = usage.threadIds.filter((id) => id !== record.threadId);
      if (
        inPlace &&
        (foreign.length ||
          usage.terminals.length ||
          usage.sessions.length ||
          usage.activeThreadIds.some((id) => id !== record.threadId) ||
          usage.queuedThreadIds.some((id) => id !== record.threadId) ||
          usage.setupThreadIds.some((id) => id !== record.threadId))
      )
        return yield* Effect.fail(
          new Error(
            "Another conversation, terminal, session, or queued operation references this checkout. Create a new worktree instead.",
          ),
        );
      if (usage.setupThreadIds.some((id) => id !== record.threadId))
        return yield* Effect.fail(new Error("Another setup or transition owns this checkout."));
      if (
        !inPlace &&
        foreign.length &&
        !record.request.sharedFilesystemConfirmed &&
        record.intent === "attach_existing"
      )
        return yield* Effect.fail(
          new Error("Confirm sharing this checkout's filesystem with the linked conversations."),
        );
      if (inPlace) yield* Effect.tryPromise(() => assertExclusiveProfileCheckout(config, path));
    });
  // Project root first when needed; remaining path locks are acquired in canonical order.
  const locked = <A, E, R>(record: WorkspaceTransitionRecord, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { project } = yield* context(record.threadId);
      if (
        record.source.path === (yield* canonicalWorkspace(project.workspaceRoot)) ||
        record.target.path === (yield* canonicalWorkspace(project.workspaceRoot))
      )
        return yield* withWorktreeLifecycleLock(
          project.workspaceRoot,
          withWorktreeLifecycleLocks(
            [record.source.path, record.target.path],
            withRepositoryLifecycleLock(config.baseDir, record.source.repository, effect),
          ),
        );
      return yield* withWorktreeLifecycleLocks(
        [record.source.path, record.target.path],
        withRepositoryLifecycleLock(config.baseDir, record.source.repository, effect),
      );
    });
  const checkContext = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const live = yield* currentRecord(record.operationId);
      if (!transitionIsActive(live) || live.version !== record.version)
        return yield* Effect.fail(new Error("Workspace transition ownership changed."));
      const { thread, project } = yield* context(record.threadId);
      if (
        thread.branch !== record.request.expected.branch ||
        thread.worktreePath !== record.request.expected.worktreePath
      )
        return yield* Effect.fail(new Error("The source workspace reference changed."));
      const setupToken = (yield* queue.listByThread(thread.id)).state.worktreeBlockToken;
      if (
        setupToken !== record.setupOwnerToken &&
        !(setupToken === null && record.setupOwnerToken !== null && record.setupOwnerOperationId)
      )
        return yield* Effect.fail(
          new Error("Workspace setup ownership changed during the transition."),
        );
      const repository = yield* git
        .resolveCommonDir(project.workspaceRoot)
        .pipe(Effect.flatMap(canonicalWorkspace));
      if (repository !== record.source.repository)
        return yield* Effect.fail(new Error("The project repository identity changed."));
      return { thread, project };
    });
  const stop = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const { thread } = yield* checkContext(record);
      const liveSessions = yield* providers.listSessions();
      const starting = yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([]);
      if (
        liveSessions.some(
          (session) =>
            session.threadId === thread.id &&
            (session.status === "connecting" || session.status === "running"),
        ) ||
        starting.some((session) => session.threadId === thread.id)
      )
        return yield* Effect.fail(
          new Error("Wait for the provider's active turn or session startup to finish."),
        );
      if (thread.session && thread.session.status !== "stopped")
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe(`workspace-stop:${record.operationId}:${record.version}`),
          threadId: thread.id,
          createdAt: new Date().toISOString(),
        });
      if (
        !thread.session &&
        (yield* providers.listSessions()).some(
          (session) => session.threadId === thread.id && session.status !== "closed",
        )
      )
        yield* providers.stopSession({ threadId: thread.id });
      yield* Effect.gen(function* () {
        while (true) {
          const sessions = yield* providers.listSessions();
          const starting = yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([]);
          const current = (yield* context(record.threadId)).thread;
          if (
            !sessions.some(
              (session) => session.threadId === record.threadId && session.status !== "closed",
            ) &&
            !starting.some((session) => session.threadId === record.threadId) &&
            (!current.session || current.session.status === "stopped")
          )
            return;
          yield* Effect.sleep("50 millis");
        }
      }).pipe(Effect.timeout("10 seconds"));
    }).pipe(Effect.timeout("10 seconds"));
  const commit = (record: WorkspaceTransitionRecord, checkout: CheckoutInspection) =>
    Effect.gen(function* () {
      const { thread, project } = yield* checkContext(record);
      const root = yield* canonicalWorkspace(project.workspaceRoot);
      const result = {
        branch: checkout.branch,
        worktreePath: checkout.canonicalRoot === root ? null : checkout.canonicalRoot,
        sessionUpdatedAt: thread.session?.updatedAt ?? null,
      };
      const applied = yield* store.update(record, {
        phase: "applied",
        observed: identity(checkout),
        fingerprint: digest(checkout),
        result,
        error: null,
        commandId: `workspace:${record.operationId}:${record.version + 1}`,
      });
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(applied.commandId),
          threadId: record.threadId,
          branch: result.branch,
          worktreePath: result.worktreePath,
        })
        .pipe(
          Effect.provideService(WorkspaceWriteContext, {
            expected: record.request.expected,
            operationId: record.operationId,
            version: applied.version,
          }),
        );
      return yield* currentRecord(record.operationId);
    });
  const apply = (initial: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      let record = yield* store.update(initial, { phase: "stopping", error: null });
      yield* stop(record);
      record = yield* locked(
        record,
        Effect.gen(function* () {
          const { thread, project } = yield* checkContext(record);
          const inPlace =
            record.intent === "checkout_branch" || record.intent === "create_branch_and_checkout";
          if (thread.session && thread.session.status !== "stopped")
            return yield* Effect.fail(new Error("The provider session did not stop."));
          yield* validateClaims(record, record.target.path, inPlace);
          if (inPlace) {
            const before = yield* inspect(record.source.path);
            if (
              before.commonDir !== record.source.repository ||
              before.canonicalRoot !== record.source.path ||
              before.operation ||
              !before.branch ||
              before.registration?.locked !== null
            )
              return yield* Effect.fail(
                new Error("The source checkout identity or Git operation changed."),
              );
            if (record.source.headSha !== before.headSha || record.source.branch !== before.branch)
              return yield* Effect.fail(
                new Error("The source checkout changed after the request."),
              );
          }
          if (inPlace && !record.request.branch)
            return yield* Effect.fail(new Error("Choose a branch."));
          if (
            record.intent === "create_branch_and_checkout" &&
            (!(yield* git.isValidBranchName(record.request.branch!)) ||
              (yield* git.branchExists(project.workspaceRoot, record.request.branch!)))
          )
            return yield* Effect.fail(
              new Error("The new branch name is invalid or already exists."),
            );
          if (record.intent === "checkout_branch") {
            const planned = yield* git.resolveCheckoutTarget({
              cwd: record.source.path,
              branch: record.request.branch!,
            });
            if (
              planned.branch !== record.target.branch ||
              planned.headSha !== record.target.headSha
            )
              return yield* Effect.fail(
                new Error("The target branch changed during workspace switching."),
              );
          } else if (
            record.intent === "attach_existing" ||
            record.intent === "use_project_checkout"
          ) {
            const checked = yield* inspectAttachableWorkspace(
              git,
              config,
              project.workspaceRoot,
              record.target.path,
              record.target.branch,
            );
            if (digest(identity(checked)) !== digest(record.target))
              return yield* Effect.fail(
                new Error("The target checkout changed during workspace switching."),
              );
          }
          const mutation =
            inPlace || record.intent === "recreate" || record.intent === "recreate_from_base";
          record = yield* store.update(record, { phase: "applying", mutationAttempted: mutation });
          if (inPlace) {
            if (!record.request.branch) return yield* Effect.fail(new Error("Choose a branch."));
            if (record.intent === "create_branch_and_checkout") {
              yield* git.createBranch({ cwd: record.source.path, branch: record.request.branch });
            }
            yield* Effect.scoped(
              git.checkoutBranch(
                { cwd: record.source.path, branch: record.request.branch },
                {
                  refreshUpstream: false,
                  expectedTarget: {
                    branch: record.target.branch!,
                    headSha: record.target.headSha!,
                  },
                },
              ),
            );
          } else if (record.intent === "recreate") {
            if (!thread.worktreePath || !thread.branch)
              return yield* Effect.fail(new Error("The worktree branch is unavailable."));
            yield* git.ensureWorktree({
              owner: `thread:${thread.id}`,
              cwd: project.workspaceRoot,
              path: record.target.path,
              branch: thread.branch,
              submodules: "none",
            });
          } else if (record.intent === "recreate_from_base") {
            const base = yield* git.resolveCommit(
              project.workspaceRoot,
              record.baseRef ?? record.target.headSha ?? "HEAD",
            );
            if (!base || base !== record.target.headSha)
              return yield* Effect.fail(new Error("The recorded recovery base changed."));
            yield* git.clearMissingRegistration(project.workspaceRoot, record.target.path);
            yield* git.createWorktree({
              cwd: project.workspaceRoot,
              branch: base,
              baseRefName: base,
              newBranch: record.target.branch!,
              path: record.target.path,
              submodules: "none",
              preparation: {
                owner: `thread:${thread.id}`,
                runSetupScript: true,
                replaceMissing: true,
              },
            });
          }
          const checkout = yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            record.target.path,
            inPlace ? undefined : record.target.branch,
          );
          const applied = yield* store.update(record, {
            phase: "applied",
            observed: identity(checkout),
            fingerprint: digest(checkout),
            error: null,
          });
          return applied;
        }),
      );
      // Preparation and submodule/network work never run under lifecycle locks.
      if (
        (record.intent === "recreate" || record.intent === "recreate_from_base") &&
        record.observed?.branch
      ) {
        const { project } = yield* context(record.threadId);
        yield* preparation.prepare({
          threadId: record.threadId,
          projectId: project.id,
          worktreePath: record.target.path,
          branch: record.observed.branch,
          retry: true,
        });
      }
      return yield* locked(
        record,
        Effect.gen(function* () {
          const { project } = yield* checkContext(record);
          const checkout = yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            record.target.path,
            record.observed?.branch,
          );
          if (digest(identity(checkout)) !== digest(record.observed))
            return yield* Effect.fail(
              new Error("The checkout changed before workspace commit. Inspect it to continue."),
            );
          yield* validateClaims(
            record,
            record.target.path,
            record.intent === "checkout_branch" || record.intent === "create_branch_and_checkout",
          );
          return yield* commit(record, checkout);
        }),
      );
    });
  const start = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const existing = workers.get(record.operationId);
      if (existing) return yield* Deferred.await(existing.result);
      const result = yield* Deferred.make<WorkspaceTransitionSnapshot, Error>();
      const work = apply(record).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const live = yield* currentRecord(record.operationId);
            if (
              live.phase === "needs_recovery" &&
              live.error === "Workspace recovery was cancelled. Inspect it before continuing."
            )
              return live;
            const failure = Cause.squash(cause);
            const conflict = Schema.is(GitCommandError)(failure)
              ? failure.checkoutConflict
              : undefined;
            let definitelyUnchanged = !live.mutationAttempted;
            if (live.intent === "checkout_branch" && conflict) {
              const actual = yield* locked(live, inspect(live.source.path)).pipe(Effect.option);
              definitelyUnchanged =
                Option.isSome(actual) && digest(identity(actual.value)) === digest(live.source);
            }
            if (transitionIsActive(live))
              return yield* store.update(live, {
                phase: definitelyUnchanged ? "failed" : "needs_recovery",
                mutationAttempted: !definitelyUnchanged,
                ...(conflict ? { checkoutConflict: conflict } : {}),
                error: failure instanceof Error ? failure.message : String(failure),
              });
            return live;
          }),
        ),
        Effect.tap((value) => Deferred.succeed(result, value)),
        Effect.catch((error) => Deferred.fail(result, error)),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            workers.delete(record.operationId);
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            const live = yield* store
              .get(record.operationId)
              .pipe(Effect.orElseSucceed(() => null));
            if (live?.phase === "cancelled") yield* Deferred.succeed(result, live);
            else
              yield* Deferred.fail(
                result,
                new Error(
                  "The workspace worker stopped. Inspect the transition before continuing.",
                ),
              );
          }),
        ),
        Effect.ensuring(dispatcher.notify(record.threadId).pipe(Effect.ignore)),
      );
      const fiber = yield* Effect.forkIn(work, scope, { startImmediately: false });
      workers.set(record.operationId, { fiber, result });
      yield* dispatcher.notify(record.threadId);
      return yield* Deferred.await(result);
    });
  const switchWorkspace: WorkspaceTransitionShape["switchWorkspace"] = (input, setupOwnerToken) =>
    Effect.gen(function* () {
      const request = {
        ...input,
        ...(input.targetPath ? { targetPath: yield* canonicalWorkspace(input.targetPath) } : {}),
        sharedFilesystemConfirmed: input.sharedFilesystemConfirmed ?? false,
      };
      const requestHash = digest(request);
      const existing = yield* store.get(input.operationId);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.threadId !== input.threadId)
          return yield* Effect.fail(new Error("This operation ID belongs to another request."));
        const worker = workers.get(input.operationId);
        return worker ? yield* Deferred.await(worker.result) : existing;
      }
      const { thread, project } = yield* context(input.threadId);
      const queueState = (yield* queue.listByThread(thread.id)).state;
      if (
        setupOwnerToken &&
        queueState.worktreeBlockToken !== null &&
        queueState.worktreeBlockToken !== setupOwnerToken
      )
        return yield* Effect.fail(new Error("Workspace setup ownership changed."));
      if (
        (yield* setup.check(
          thread.id,
          (yield* queue.listByThread(thread.id)).state.worktreeBlockToken,
        )) === "gating" &&
        !setupOwnerToken
      )
        return yield* Effect.fail(new Error("Workspace setup is in progress."));
      const repository = yield* git
        .resolveCommonDir(project.workspaceRoot)
        .pipe(Effect.flatMap(canonicalWorkspace));
      const sourcePath = yield* canonicalWorkspace(thread.worktreePath ?? project.workspaceRoot);
      // Missing sources are supported by recovery; all other inspection errors remain blocking.
      const source = yield* inspect(sourcePath).pipe(
        Effect.map(identity),
        Effect.catch((error) =>
          ["recreate", "recreate_from_base", "use_project_checkout"].includes(input.intent) &&
          thread.worktreePath !== null
            ? Effect.succeed({ path: sourcePath, repository, branch: thread.branch, headSha: null })
            : Effect.fail(error),
        ),
      );
      if (source.repository !== repository)
        return yield* Effect.fail(new Error("The source belongs to another repository."));
      let target = source;
      let baseRef: string | undefined;
      if (input.intent === "attach_existing" || input.intent === "use_project_checkout") {
        const path =
          input.intent === "use_project_checkout" ? project.workspaceRoot : input.targetPath;
        if (!path) return yield* Effect.fail(new Error("Choose a checkout."));
        target = identity(
          yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            path,
            input.intent === "attach_existing" ? input.branch : undefined,
          ),
        );
      } else if (input.intent === "recreate_from_base") {
        const base =
          (yield* git.readDefaultBranch(project.workspaceRoot)) ??
          (yield* git.inspectCheckoutIdentity(project.workspaceRoot)).branch;
        const sha = base ? yield* git.resolveCommit(project.workspaceRoot, base) : null;
        if (!sha) return yield* Effect.fail(new Error("No committed recovery base is available."));
        const branch =
          thread.branch && !(yield* git.branchExists(project.workspaceRoot, thread.branch))
            ? thread.branch
            : `t3code/${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
        baseRef = base!;
        const managed = yield* canonicalWorkspace(config.worktreesDir);
        const missing = yield* Effect.tryPromise({
          try: async () => {
            try {
              await lstat(sourcePath);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
              throw error;
            }
          },
          catch: (error) => new WorkspaceTransitionError(String(error)),
        });
        target = {
          path:
            missing && sourcePath !== managed && pathContains(managed, sourcePath)
              ? sourcePath
              : yield* git.allocateWorktreePath({ cwd: project.workspaceRoot, branch }),
          repository,
          branch,
          headSha: sha,
        };
      } else if (input.intent === "checkout_branch") {
        if (!input.branch) return yield* Effect.fail(new Error("Choose a branch."));
        const planned = yield* git.resolveCheckoutTarget({
          cwd: source.path,
          branch: input.branch,
        });
        if (!planned.branch || !planned.headSha)
          return yield* Effect.fail(
            new Error(
              "The branch is unavailable or would detach this checkout. Create a new worktree instead.",
            ),
          );
        target = { ...source, branch: planned.branch, headSha: planned.headSha };
      } else if (input.intent === "create_branch_and_checkout")
        target = { ...source, branch: input.branch ?? null };
      const at = new Date().toISOString();
      const proposed: WorkspaceTransitionRecord = {
        operationId: input.operationId,
        threadId: input.threadId,
        version: 0,
        intent: input.intent,
        phase: "reserved",
        request,
        requestHash,
        ...(baseRef ? { baseRef } : {}),
        source,
        target,
        observed: null,
        fingerprint: null,
        mutationAttempted: false,
        error: null,
        result: null,
        setupOwnerToken: setupOwnerToken ? queueState.worktreeBlockToken : null,
        ...(setupOwnerToken ? { setupOwnerOperationId: setupOwnerToken } : {}),
        commandId: `workspace:${input.operationId}`,
        createdAt: at,
        updatedAt: at,
      };
      const record = yield* locked(proposed, store.reserve(proposed));
      return yield* start(record);
    });
  const recoveryInspection = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const actual = yield* inspect(record.observed?.path ?? record.target.path).pipe(
        Effect.option,
      );
      const original = yield* inspect(record.source.path).pipe(Effect.option);
      const token = digest({
        secret,
        version: record.version,
        operationId: record.operationId,
        actual: Option.getOrNull(actual),
        original: Option.getOrNull(original),
      });
      return { actual: Option.getOrNull(actual), original: Option.getOrNull(original), token };
    });
  const previewRecovery: WorkspaceTransitionShape["previewRecovery"] = ({ operationId }) =>
    Effect.gen(function* () {
      const record = yield* currentRecord(operationId);
      const inspected = yield* locked(record, recoveryInspection(record));
      return {
        transition: workspaceTransitionSnapshot(record),
        actual: inspected.actual ? identity(inspected.actual) : null,
        original: inspected.original ? identity(inspected.original) : null,
        acceptanceToken: inspected.token,
        canRetry: !record.mutationAttempted && !workers.has(record.operationId),
        blockedReasons: inspected.actual ? [] : ["The target checkout could not be verified."],
      };
    });
  const resolve: WorkspaceTransitionShape["resolve"] = (input) =>
    Effect.gen(function* () {
      let record = yield* currentRecord(input.operationId);
      if (workers.has(record.operationId))
        return yield* Effect.fail(new Error("The workspace worker is still running."));
      if (record.version !== input.version || !["needs_recovery", "failed"].includes(record.phase))
        return yield* Effect.fail(new Error("The transition changed. Preview recovery again."));
      if (input.action !== "retry") {
        if (record.phase === "failed")
          return yield* Effect.fail(
            new Error("Retry this pre-mutation failure or start a new workspace switch."),
          );
        // Closing an idle session and waiting for its projection must happen outside all lifecycle locks.
        yield* stop(record);
      }
      let retry = false;
      const resolved = yield* locked(
        record,
        Effect.gen(function* () {
          record = yield* currentRecord(input.operationId);
          if (
            record.version !== input.version ||
            !["needs_recovery", "failed"].includes(record.phase)
          )
            return yield* Effect.fail(new Error("The transition changed. Preview recovery again."));
          const inspected = yield* recoveryInspection(record);
          if (inspected.token !== input.acceptanceToken)
            return yield* Effect.fail(new Error("The checkout changed. Preview recovery again."));
          if (input.action === "retry") {
            if (record.mutationAttempted)
              return yield* Effect.fail(
                new Error(
                  "The Git outcome may be partial. Accept a verified workspace instead of repeating Git.",
                ),
              );
            record = yield* store.reactivate(record);
            retry = true;
            return record;
          }
          const selected =
            input.action === "keep_original_workspace" ? inspected.original : inspected.actual;
          if (!selected)
            return yield* Effect.fail(new Error("The selected checkout is unavailable."));
          if (
            input.action === "keep_original_workspace" &&
            (selected.commonDir !== record.source.repository ||
              selected.branch !== record.source.branch ||
              selected.headSha !== record.source.headSha)
          )
            return yield* Effect.fail(
              new Error(
                "The original checkout no longer matches its recorded identity. No files were restored.",
              ),
            );
          const { project } = yield* checkContext(record);
          yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            selected.canonicalRoot,
            selected.branch,
          );
          yield* validateClaims(record, selected.canonicalRoot, false);
          return yield* commit(record, selected);
        }),
      );
      const result = retry ? yield* start(resolved) : resolved;
      yield* dispatcher.notify(record.threadId);
      return result;
    });
  const cancel: WorkspaceTransitionShape["cancel"] = (threadId, retainBarrier = false) =>
    Effect.gen(function* () {
      const record = yield* store.forThread(threadId);
      if (!record) return;
      if (retainBarrier && transitionIsActive(record))
        yield* store.update(record, {
          phase: "needs_recovery",
          error: "Workspace recovery was cancelled. Inspect it before continuing.",
        });
      else yield* store.cancel(threadId);
      const worker = workers.get(record.operationId);
      if (worker) yield* Fiber.interrupt(worker.fiber);
    });
  yield* store.reconcile;
  yield* Effect.forkIn(
    Stream.runForEach(engine.streamDomainEvents, (event) => {
      if (event.type !== "thread.archived" && event.type !== "thread.deleted") return Effect.void;
      return cancel(event.payload.threadId).pipe(Effect.ignore);
    }),
    scope,
  );
  return {
    switchWorkspace: (input, owner) =>
      withOwner(input.operationId, switchWorkspace(input, owner)).pipe(
        Effect.map((record) => workspaceTransitionSnapshot(record)),
      ),
    getTransition: ({ threadId }) =>
      readTransition(threadId).pipe(
        Effect.map((record) => (record ? workspaceTransitionSnapshot(record) : null)),
      ),
    previewRecovery,
    resolve: (input) =>
      withOwner(input.operationId, resolve(input)).pipe(
        Effect.map((record) => workspaceTransitionSnapshot(record)),
      ),
    cancel,
  } satisfies WorkspaceTransitionShape;
});
export const WorkspaceTransitionLive = Layer.effect(WorkspaceTransition, makeWorkspaceTransition);
