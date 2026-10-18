import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueStorageError } from "../../nextTurnQueue/Errors.ts";
import { holdsWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";
import type { OrchestrationCommand } from "@t3tools/contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import {
  automationLayer,
  makeWorld,
  makeClonedRepo,
  git,
  project,
  thread,
} from "../../storage/storageAutomation.testHarness.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { WorktreeSetupGate, WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { makeWorktreeManager } from "./WorktreeManager.ts";

describe("WorktreeManager safety and recovery", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  async function fixture() {
    const repo = await makeClonedRepo("f5-manager-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    const projectId = ProjectId.makeUnsafe("p");
    const notified: string[] = [];
    const run = <A, E>(
      effect: (
        manager: Effect.Success<typeof makeWorktreeManager>,
        root: string,
        gate: typeof WorktreeSetupGate.Service,
      ) => Effect.Effect<A, E>,
      overrides: Partial<GitCoreShape> = {},
      hooks: {
        beforeStop?: () => Effect.Effect<void>;
        onDispatch?: (command: OrchestrationCommand) => void;
        failTokenClear?: () => boolean;
      } = {},
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const originalGit = yield* GitCore;
          const providers = yield* ProviderService;
          const engine = yield* OrchestrationEngineService;
          const queue = yield* NextTurnQueueStore;
          const manager = yield* makeWorktreeManager.pipe(
            Effect.provideService(ProviderService, {
              ...providers,
              stopSession: (input) =>
                (hooks.beforeStop?.() ?? Effect.void).pipe(
                  Effect.andThen(providers.stopSession(input)),
                ),
            }),
            Effect.provideService(OrchestrationEngineService, {
              ...engine,
              dispatch: (command) =>
                engine
                  .dispatch(command)
                  .pipe(Effect.tap(() => Effect.sync(() => hooks.onDispatch?.(command)))),
            }),
            Effect.provideService(NextTurnQueueStore, {
              ...queue,
              setWorktreeBlockToken: (input) =>
                input.token === null && hooks.failTokenClear?.()
                  ? Effect.fail(
                      new NextTurnQueueStorageError({
                        message: "interrupted token clear",
                      }),
                    )
                  : queue.setWorktreeBlockToken(input),
            }),
            Effect.provideService(GitCore, { ...originalGit, ...overrides }),
          );
          const config = yield* ServerConfig;
          return yield* effect(manager, config.worktreesDir, yield* WorktreeSetupGate);
        }).pipe(
          Effect.provide(WorktreeSetupGateLive),
          Effect.provideService(NextTurnQueueDispatcher, {
            notify: (id: string) =>
              Effect.sync(() => {
                notified.push(id);
              }),
          } as never),
          Effect.provide(automationLayer(world, {}, "f5-manager-state-")),
          Effect.scoped,
        ),
      );
    return { repo, world, projectId, run, notified };
  }
  it("rechecks HEAD and claims, then deletes only an unreferenced merged branch", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "feature");
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.branchMerged).toBe(true);
        expect(preview.branchDeletable).toBe(true);
        expect(
          (yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: "wrong",
          })).removed,
        ).toBe(false);
        world.threads.push(
          thread({ id: "linked", projectId, worktreePath: target, branch: "feature" }),
        );
        world.queuedThreadIds.add("linked");
        expect(
          (yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: preview.headSha,
          })).removed,
        ).toBe(false);
        world.queuedThreadIds.clear();
        const kept = yield* manager.remove({
          projectId,
          path: target,
          deleteBranch: true,
          expectedHead: preview.headSha,
        });
        expect(kept.removed).toBe(true);
        expect(kept.branchDeleted).toBe(false);
        expect(world.threads[0]?.worktreePath).toBe(target);
        git(repo.root, "worktree", "add", "-q", "-b", "unlinked", target, "main");
        world.threads.length = 0;
        const fresh = yield* manager.inspect({ projectId, path: target });
        expect(
          yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: fresh.headSha,
          }),
        ).toEqual({ removed: true, branchDeleted: true, blockedReasons: [] });
      }),
    );
  });
  it("stops deleted owners but retains unmerged commits when the upstream is gone", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "upstream-gone");
        git(repo.root, "worktree", "add", "-q", "-b", "upstream-gone", target, "main");
        git(target, "commit", "--allow-empty", "-qm", "unique commit");
        git(target, "config", "branch.upstream-gone.remote", "origin");
        git(target, "config", "branch.upstream-gone.merge", "refs/heads/deleted-upstream");
        world.threads.push(
          thread({
            id: "deleted",
            projectId,
            worktreePath: null,
            deletedAt: new Date().toISOString(),
          }),
        );
        world.sessions.push({ threadId: "deleted", cwd: target, status: "ready" });
        world.terminals.push({
          threadId: "deleted",
          terminalId: "shell",
          cwd: target,
          status: "running",
        });
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.branchMerged).toBe(false);
        expect(preview.branchUpstreamGone).toBe(true);
        expect(preview.branchDeletable).toBe(false);
        expect(preview.deletedThreadClaims).toContain("deleted");
        expect(
          yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: preview.headSha,
          }),
        ).toMatchObject({ removed: true, branchDeleted: false });
        expect(git(repo.root, "rev-parse", "refs/heads/upstream-gone")).toBe(preview.headSha);
        expect(world.sessions).toEqual([]);
        expect(world.terminals).toEqual([]);
      }),
    );
  });
  it("recreates stale registrations and resumes only a missing-worktree pause", async () => {
    const { repo, world, run, notified } = await fixture();
    const threadId = ThreadId.makeUnsafe("recover");
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "missing");
        git(repo.root, "worktree", "add", "-q", "-b", "recovery", target, "main");
        yield* Effect.promise(() => fs.rm(target, { recursive: true }));
        world.threads.push(
          thread({ id: threadId, projectId: "p", worktreePath: target, branch: "recovery" }),
        );
        world.queueStates.set(threadId, {
          revision: 1,
          paused: true,
          pauseReasonCode: "worktree_missing",
          worktreeBlockToken: null,
        });
        expect((yield* manager.threadState({ threadId })).registration).toBe("stale");
        expect(
          (yield* manager.recover({ threadId, action: "recreate", expectedQueueRevision: 1 }))
            .directoryExists,
        ).toBe(true);
        expect(world.queueStates.get(threadId)?.paused).toBe(false);
        yield* Effect.promise(() => fs.rm(target, { recursive: true }));
        world.queueStates.set(threadId, {
          revision: 10,
          paused: true,
          pauseReasonCode: "manual_pause",
          worktreeBlockToken: null,
        });
        const recovered = yield* manager.recover({
          threadId,
          action: "recreateFromBase",
          expectedQueueRevision: 10,
        });
        expect(recovered.directoryExists).toBe(true);
        expect(recovered.registration).toBe("matching");
        expect(recovered.branch).not.toBe("recovery");
        expect(world.queueStates.get(threadId)?.pauseReasonCode).toBe("manual_pause");
        expect(notified).toEqual([threadId, threadId]);
      }),
    );
  });
  it("rejects pending turns and stale revisions before changing workspace", async () => {
    const { repo, world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("blocked");
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "absent");
        world.threads.push(thread({ id: threadId, projectId: "p", worktreePath: target }));
        world.pendingTurnStarts.add(threadId);
        expect(
          (yield* manager
            .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 0 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        world.pendingTurnStarts.clear();
        expect(
          (yield* manager
            .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 9 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(world.threads[0]?.worktreePath).toBe(target);
        world.sessions.push({ threadId, cwd: target, status: "ready" });
        expect(
          (yield* manager.recover({
            threadId,
            action: "useProjectCheckout",
            expectedQueueRevision: 0,
          })).worktreePath,
        ).toBe(null);
        expect(world.sessions).toEqual([]);
        expect(git(repo.root, "branch", "--show-current")).toBe("main");
      }),
    );
  });
  it("does not claim an equal branch name in a different repository", async () => {
    const { repo, world, projectId, run } = await fixture();
    const other = await makeClonedRepo("f5-manager-other-");
    cleanups.push(other.cleanup);
    world.projects.push(project("other", other.root));
    world.threads.push(
      thread({ id: "other", projectId: "other", branch: "feature", worktreePath: null }),
    );
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "feature");
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        expect((yield* manager.inspect({ projectId, path: target })).branchDeletable).toBe(true);
        world.projects.push(project("alias", repo.root));
        world.threads.push(
          thread({ id: "same-repo", projectId: "alias", branch: "feature", worktreePath: null }),
        );
        expect((yield* manager.inspect({ projectId, path: target })).branchDeletable).toBe(false);
      }),
    );
  });

  it("leaves a failed post-checkout recovery retryable without restarting", async () => {
    const { repo, world, run } = await fixture();
    let fail = true;
    const threadId = ThreadId.makeUnsafe("failed-recovery");
    await run(
      (manager, root, gate) =>
        Effect.gen(function* () {
          const target = path.join(root, "retry");
          git(repo.root, "worktree", "add", "-q", "-b", "retry", target, "main");
          world.threads.push(
            thread({ id: threadId, projectId: "p", branch: "retry", worktreePath: target }),
          );
          expect(
            (yield* manager
              .recover({ threadId, action: "recreate", expectedQueueRevision: 0 })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          const state = world.queueStates.get(threadId)!;
          expect(state.worktreeBlockToken).toMatch(/^recovery:/);
          expect(yield* gate.check(threadId, state.worktreeBlockToken)).toBe("orphaned");
          expect((yield* manager.threadState({ threadId })).recovery).toBe("interrupted");
          // The dispatcher reconciles a durable orphan after a restart this way.
          world.queueStates.set(threadId, {
            ...state,
            paused: true,
            pauseReasonCode: "worktree_setup_failed",
          });
          fail = false;
          yield* manager.recover({
            threadId,
            action: "recreate",
            expectedQueueRevision: state.revision,
          });
          expect(world.queueStates.get(threadId)?.worktreeBlockToken).toBeNull();
          expect(world.queueStates.get(threadId)?.paused).toBe(false);
          expect((yield* manager.threadState({ threadId })).recovery).toBe("none");
        }),
      {
        initializeWorktreeSubmodules: () =>
          Effect.suspend(() =>
            fail
              ? Effect.fail(
                  new GitCommandError({
                    operation: "test",
                    command: "submodule",
                    cwd: repo.root,
                    detail: "network unavailable",
                  }),
                )
              : Effect.void,
          ),
      },
    );
  });

  it.each([false, true])(
    "reserves before stopping and detects a just-accepted turn (race: %s)",
    async (raced) => {
      const { repo, world, run } = await fixture();
      const threadId = ThreadId.makeUnsafe("reserve-recovery");
      let target = "";
      let stops = 0;
      await run(
        (manager, root) =>
          Effect.gen(function* () {
            target = path.join(root, "reserve");
            git(repo.root, "worktree", "add", "-q", "-b", "reserve", target, "main");
            world.threads.push(
              thread({ id: threadId, projectId: "p", branch: "reserve", worktreePath: target }),
            );
            world.sessions.push({ threadId, cwd: target, status: "ready" });
            const result = yield* manager
              .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 0 })
              .pipe(Effect.exit);
            expect(result._tag).toBe(raced ? "Failure" : "Success");
            expect(stops).toBe(raced ? 0 : 1);
          }),
        {},
        {
          onDispatch: (command) => {
            if (
              raced &&
              command.type === "thread.activity.append" &&
              (command.activity.payload as { phase?: string } | null)?.phase === "reserved"
            )
              world.pendingTurnStarts.add(threadId);
          },
          beforeStop: () =>
            Effect.gen(function* () {
              stops++;
              expect(world.queueStates.get(threadId)?.worktreeBlockToken).toMatch(/^recovery:/);
              expect(yield* holdsWorktreeLifecycleLock(target)).toBe(false);
            }).pipe(Effect.orDie),
        },
      );
    },
  );

  it("retries after local metadata commits but clearing the recovery token fails", async () => {
    const { repo, world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("local-retry");
    let fail = true;
    await run(
      (manager, root) =>
        Effect.gen(function* () {
          const target = path.join(root, "local-retry");
          git(repo.root, "worktree", "add", "-q", "-b", "local-retry", target, "main");
          world.threads.push(
            thread({ id: threadId, projectId: "p", branch: "local-retry", worktreePath: target }),
          );
          expect(
            (yield* manager
              .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 0 })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(yield* manager.threadState({ threadId })).toMatchObject({
            worktreePath: null,
            recovery: "interrupted",
          });
          fail = false;
          yield* manager.recover({
            threadId,
            action: "useProjectCheckout",
            expectedQueueRevision: world.queueStates.get(threadId)!.revision,
          });
          expect((yield* manager.threadState({ threadId })).recovery).toBe("none");
        }),
      { inspectCheckout: () => Effect.die("Switching to the root must use identity only") },
      { failTokenClear: () => fail },
    );
  });

  it.each([false, true])(
    "unregisters recovery and retains retry state after interruption (cancel RPC: %s)",
    async (cancelRpc) => {
      const { repo, world, run } = await fixture();
      const threadId = ThreadId.makeUnsafe("interrupted-recovery");
      world.projects[0] = {
        ...world.projects[0]!,
        scripts: [
          {
            id: "setup",
            name: "setup",
            command: "echo diagnostic; echo started > setup-started; sleep 30",
            icon: "play",
            runOnWorktreeCreate: true,
          },
        ],
      };
      await run((manager, root, gate) =>
        Effect.gen(function* () {
          const target = path.join(root, "interrupt");
          git(repo.root, "worktree", "add", "-q", "-b", "interrupt", target, "main");
          world.threads.push(
            thread({ id: threadId, projectId: "p", branch: "interrupt", worktreePath: target }),
          );
          const fiber = yield* manager
            .recover({ threadId, action: "recreate", expectedQueueRevision: 0 })
            .pipe(Effect.forkChild);
          yield* Effect.promise(async () => {
            for (let i = 0; i < 200; i++) {
              if (
                await fs.access(path.join(target, "setup-started")).then(
                  () => true,
                  () => false,
                )
              )
                return;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("setup script did not start");
          });
          if (cancelRpc) {
            const cancelled = yield* manager.recover({
              threadId,
              action: "cancel",
              expectedQueueRevision: world.queueStates.get(threadId)!.revision,
            });
            expect(cancelled.recovery).toBe("interrupted");
          } else yield* Fiber.interrupt(fiber);
          const state = world.queueStates.get(threadId)!;
          expect(yield* gate.check(threadId, state.worktreeBlockToken)).toBe("orphaned");
          // An explicit retry can safely choose the project checkout after interruption.
          yield* manager.recover({
            threadId,
            action: "useProjectCheckout",
            expectedQueueRevision: state.revision,
          });
          expect(world.queueStates.get(threadId)?.worktreeBlockToken).toBeNull();
        }),
      );
    },
  );
});
