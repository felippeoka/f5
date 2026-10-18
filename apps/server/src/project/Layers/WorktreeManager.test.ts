import { WorktreePreparations } from "../../persistence/Services/WorktreePreparations.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { makeWorktreePreparationService } from "./WorktreePreparation.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueStorageError } from "../../nextTurnQueue/Errors.ts";
import type { OrchestrationCommand } from "@t3tools/contracts";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
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
      ) => Effect.Effect<A, E, GitCore | WorktreePreparations>,
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
          const preparation = yield* makeWorktreePreparationService.pipe(
            Effect.provideService(GitCore, { ...originalGit, ...overrides }),
          );
          const manager = yield* makeWorktreeManager.pipe(
            Effect.provideService(WorktreePreparation, preparation),
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

  it("requires the durable transition service for recovery and keeps queue pauses intact", async () => {
    const { world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("recovery-owner");
    world.threads.push(
      thread({ id: threadId, projectId: "p", branch: "main", worktreePath: null }),
    );
    world.queueStates.set(threadId, {
      revision: 7,
      paused: true,
      pauseReasonCode: "manual_pause",
      worktreeBlockToken: null,
    });
    await run((manager) =>
      Effect.gen(function* () {
        expect(
          (yield* manager
            .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 7 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(world.queueStates.get(threadId)?.pauseReasonCode).toBe("manual_pause");
      }),
    );
  });
});
