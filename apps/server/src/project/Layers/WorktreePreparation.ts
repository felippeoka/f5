import { GitCommandError } from "../../git/Errors.ts";
import { CommandId, EventId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import { Cause, Deferred, Effect, Fiber, Layer, Schema, Semaphore } from "effect";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  PreparationError,
  WorktreePreparations,
  needsPreparation,
} from "../../persistence/Services/WorktreePreparations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readProjectSettings } from "../projectSettings.ts";
import { startOwnedSetupScript } from "../ownedSetupScript.ts";
import {
  WorktreePreparation,
  type PrepareThreadWorktree,
} from "../Services/WorktreePreparation.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import { withWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

export const makeWorktreePreparationService = Effect.gen(function* () {
  const git = yield* GitCore;
  const settings = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* WorktreePreparations;
  const gate = yield* WorktreeSetupGate;
  const queue = yield* NextTurnQueueStore;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const running = new Map<
    string,
    { fingerprint: string; done: Deferred.Deferred<void, PreparationError> }
  >();
  const canonical = (path: string) =>
    Effect.tryPromise({
      try: () => canonicalWorktreePath(path),
      catch: (cause) =>
        new PreparationError({ message: String(cause), path, recoveryRequired: true }),
    });
  const prepare = (input: PrepareThreadWorktree): Effect.Effect<void, PreparationError> =>
    Effect.gen(function* () {
      // Git/filesystem work never holds the map semaphore.
      const path = yield* canonical(input.worktreePath);
      const fingerprint = JSON.stringify([
        input.threadId,
        input.projectId,
        input.branch,
        input.retry === true,
      ]);
      let ownedFiber: Fiber.Fiber<void, never> | null = null;
      const done = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const previous = running.get(path);
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              return yield* new PreparationError({
                message: "A different owner is preparing this checkout.",
                path,
                recoveryRequired: true,
              });
            return previous.done;
          }
          const done = yield* Deferred.make<void, PreparationError>();
          running.set(path, { fingerprint, done });
          const run = Effect.gen(function* () {
            let receipt = yield* withWorktreeLifecycleLock(
              path,
              Effect.gen(function* () {
                const receipt = yield* receipts.latest(path);
                if (!receipt) return null; // Legacy checkouts are never re-prepared.
                const inspected = yield* git.inspectCheckout(path);
                if (
                  inspected.commonDir !== receipt.repositoryIdentity ||
                  inspected.branch !== input.branch ||
                  inspected.canonicalRoot !== path ||
                  !inspected.registration
                )
                  return yield* new PreparationError({
                    message:
                      "Checkout identity changed. Inspect the retained worktree before retrying.",
                    path,
                    operationId: receipt.operationId,
                    recoveryRequired: true,
                  });
                if (receipt.phase === "allocated") {
                  const status = yield* git.inspectCheckout(path);
                  if (
                    status.headSha !== receipt.baseOid ||
                    status.hasTrackedChanges ||
                    status.hasUntrackedChanges ||
                    status.ignoredEntries.length > 0
                  )
                    return yield* new PreparationError({
                      message:
                        "Creation was interrupted; the retained checkout needs explicit recovery.",
                      path,
                      operationId: receipt.operationId,
                      recoveryRequired: true,
                    });
                  if (!input.retry)
                    return yield* new PreparationError({
                      message: "Confirm setup before reusing this interrupted checkout.",
                      path,
                      operationId: receipt.operationId,
                      recoveryRequired: true,
                    });
                  return yield* receipts.update(receipt, { phase: "checkout_created" });
                }
                return receipt;
              }),
            ).pipe(
              Effect.mapError((error) =>
                Schema.is(PreparationError)(error)
                  ? error
                  : new PreparationError({ message: error.message, path }),
              ),
            );
            if (!receipt || receipt.phase === "completed" || receipt.phase === "skipped") return;
            if (receipt.phase === "setup_indeterminate" && !input.retry)
              return yield* new PreparationError({
                message:
                  receipt.error ??
                  "Explicitly retry interrupted setup; scripts may have external effects.",
                path,
                operationId: receipt.operationId,
                recoveryRequired: true,
              });
            if (receipt.phase === "setup_failed" && !input.retry) return; // Reported failure does not block a turn.
            if (receipt.phase === "setup_running")
              return yield* new PreparationError({
                message: "Setup is already running for this checkout.",
                path,
              });
            const project = (yield* engine.getReadModel()).projects.find(
              (p) => p.id === input.projectId && p.deletedAt === null,
            );
            if (!project)
              return yield* new PreparationError({
                message: "The preparation project is unavailable.",
                path,
              });
            const resolved = yield* readProjectSettings(yield* settings.getSettings, project);
            const script = receipt.runSetupScript ? setupProjectScript(project.scripts) : null;
            if (
              script &&
              receipt.setupIdentity !== null &&
              receipt.setupIdentity !== script.command
            )
              return yield* new PreparationError({
                message:
                  "The setup script changed. Confirm a new preparation request before running it.",
                path,
                recoveryRequired: true,
              });
            receipt = yield* receipts.update(receipt, {
              phase: "setup_running",
              error: null,
              setupIdentity: script?.command ?? receipt.setupIdentity,
            });
            // Owned processes run without lifecycle locks or terminal claims.
            const result = yield* Effect.gen(function* () {
              yield* git.initializeWorktreeSubmodules(path, resolved.settings.worktreeSubmodules);
              if (script) {
                const process = yield* startOwnedSetupScript({
                  command: script.command,
                  cwd: path,
                  env: projectScriptRuntimeEnv({
                    project: { cwd: project.workspaceRoot },
                    worktreePath: path,
                  }),
                  onLine: () => {},
                });
                const code = yield* process.exit.pipe(Effect.onInterrupt(() => process.kill));
                if (code !== 0)
                  return yield* new PreparationError({
                    message: `Worktree setup script failed (${code ?? "interrupted"}).`,
                    path,
                  });
              }
            }).pipe(Effect.exit);
            if (result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause)) {
              yield* receipts
                .update(receipt, {
                  phase: "setup_indeterminate",
                  error:
                    "Setup was interrupted. Explicit retry acknowledges possible external effects.",
                })
                .pipe(Effect.ignoreCause({ log: true }));
              return yield* Effect.interrupt;
            }
            const error = result._tag === "Failure" ? Cause.pretty(result.cause) : null;
            yield* receipts.update(receipt, { phase: error ? "setup_failed" : "completed", error });
            if (result._tag === "Failure" && Schema.is(GitCommandError)(Cause.squash(result.cause)))
              return yield* new PreparationError({ message: error!, path, recoveryRequired: true });
            const createdAt = new Date().toISOString();
            if (
              (yield* engine.getReadModel()).threads.some(
                (thread) => thread.id === input.threadId && thread.deletedAt === null,
              )
            )
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.makeUnsafe(`worktree-prepared:${crypto.randomUUID()}`),
                threadId: input.threadId,
                activity: {
                  id: EventId.makeUnsafe(`worktree-prepared:${input.threadId}`),
                  kind: "worktree.prepared",
                  tone: error ? "error" : "info",
                  summary: error ?? "Worktree prepared",
                  payload: { path, operationId: receipt.operationId, error },
                  turnId: null,
                  createdAt,
                },
                createdAt,
              });
          }).pipe(
            Effect.mapError((error) =>
              Schema.is(PreparationError)(error)
                ? error
                : new PreparationError({ message: error.message, path }),
            ),
          );
          ownedFiber = yield* run.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)) {
                  const latest = yield* receipts.latest(path);
                  if (latest?.phase === "setup_running")
                    yield* receipts.update(latest, {
                      phase: "setup_indeterminate",
                      error:
                        "Setup was interrupted. Explicit retry acknowledges possible external effects.",
                    });
                }
              }).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.andThen(
                  mutex.withPermits(1)(
                    Effect.gen(function* () {
                      running.delete(path);
                      yield* Deferred.done(done, exit);
                    }),
                  ),
                ),
              ),
            ),
            Effect.ignoreCause,
            Effect.forkIn(scope),
          );
          return done;
        }),
      );
      yield* Deferred.await(done).pipe(
        Effect.onInterrupt(() =>
          ownedFiber ? Fiber.interrupt(ownedFiber).pipe(Effect.asVoid) : Effect.void,
        ),
      );
    });
  return WorktreePreparation.of({
    prepare,
    needsPreparation: (path) =>
      canonical(path).pipe(Effect.flatMap(receipts.latest), Effect.map(needsPreparation)),
    startup: receipts.reconcile,
    startBackground: (input, notify) =>
      Effect.gen(function* () {
        const token = `preparation:${crypto.randomUUID()}`;
        yield* gate.register(input.threadId, token);
        yield* queue.setWorktreeBlockToken({ threadId: input.threadId, token });
        yield* prepare(input).pipe(
          Effect.catch((error) =>
            queue
              .setPaused({
                threadId: input.threadId,
                paused: true,
                reasonCode: "worktree_setup_failed",
                detail: error.message,
              })
              .pipe(Effect.ignoreCause({ log: true })),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* gate.open(input.threadId, token);
              yield* queue
                .setWorktreeBlockToken({
                  threadId: input.threadId,
                  token: null,
                  expectedToken: token,
                })
                .pipe(Effect.ignoreCause({ log: true }));
              yield* gate.unregister(input.threadId, token);
              yield* notify();
            }),
          ),
          Effect.forkIn(scope),
        );
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(PreparationError)(error)
            ? error
            : new PreparationError({ message: error.message }),
        ),
      ),
  });
});
export const WorktreePreparationLive = Layer.effect(
  WorktreePreparation,
  makeWorktreePreparationService,
);
