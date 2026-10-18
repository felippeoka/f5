import { WorktreePreparations } from "../../persistence/Services/WorktreePreparations.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { WorktreeSetupLive } from "./WorktreeSetup.ts";
import { WorktreeSetup } from "../Services/WorktreeSetup.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { makeFakeTextGeneration } from "../../git/testDoubles.ts";
import { PreparationError } from "../../persistence/Services/WorktreePreparations.ts";
import { makeWorktreeManager } from "./WorktreeManager.ts";
import { ProfileRegistryStore } from "../../profiles/ProfileRegistryStore.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Deferred } from "effect";
import {
  automationLayer,
  makeClonedRepo,
  makeWorld,
  git,
} from "../../storage/storageAutomation.testHarness.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { makeWorkspaceTransitions } from "../../persistence/Layers/WorkspaceTransitions.ts";
import {
  WorkspaceTransitions,
  WorkspaceTransitionError,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import { NextTurnQueueStoreLive } from "../../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { WorkspaceTransitionLive } from "./WorkspaceTransition.ts";
import {
  holdsWorktreeLifecycleLock,
  withWorktreeLifecycleLock,
} from "./WorktreeLifecycleCoordinator.ts";

// Use the existing real-Git automation fixture and the real engine/SQL transaction pipeline.
describe("workspace transition execution", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture() {
    const repo = await makeClonedRepo("f5-transition-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    const base = automationLayer(world, {}, "f5-transition-state-");
    const failPhase: { current: string | null } = { current: null };
    const preparationControl = { fail: false, block: false };
    const preparationEntered = Deferred.makeUnsafe<void>();
    const mutationEntered = Deferred.makeUnsafe<void>();
    const mutationControl = { fail: false, block: false };
    const gitLayer = Layer.effect(
      GitCore,
      Effect.gen(function* () {
        const gitCore = yield* GitCore;
        const beforeMutation = Effect.suspend(() =>
          Deferred.succeed(mutationEntered, undefined).pipe(
            Effect.andThen(
              mutationControl.block
                ? Effect.never
                : mutationControl.fail
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "test-worktree-add",
                        cwd: repo.root,
                        command: "git worktree add",
                        detail: "Git add failed before creating a checkout",
                      }),
                    )
                  : Effect.void,
            ),
          ),
        );
        return {
          ...gitCore,
          ensureWorktree: (input: Parameters<typeof gitCore.ensureWorktree>[0]) =>
            beforeMutation.pipe(Effect.andThen(gitCore.ensureWorktree(input))),
          createWorktree: (input: Parameters<typeof gitCore.createWorktree>[0]) =>
            beforeMutation.pipe(Effect.andThen(gitCore.createWorktree(input))),
        };
      }),
    ).pipe(Layer.provide(base));
    const storeLayer = Layer.effect(
      WorkspaceTransitions,
      makeWorkspaceTransitions.pipe(
        Effect.map((store) => ({
          ...store,
          update: (
            record: Parameters<typeof store.update>[0],
            patch: Parameters<typeof store.update>[1],
          ) =>
            store
              .update(record, patch)
              .pipe(
                Effect.tap((next) =>
                  failPhase.current === next.phase
                    ? Effect.fail(new WorkspaceTransitionError(`crash after ${next.phase}`))
                    : Effect.void,
                ),
              ),
        })),
      ),
    );
    const engineLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(NextTurnQueueStoreLive),
    );
    const preparations: string[] = [];
    const transitionLayer = WorkspaceTransitionLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(WorktreeSetupGateLive),
      Layer.provideMerge(
        Layer.effect(
          WorktreePreparation,
          Effect.gen(function* () {
            const receipts = yield* WorktreePreparations;
            return {
              startup: Effect.void,
              needsPreparation: () => Effect.succeed(false),
              startBackground: () => Effect.void,
              prepare: ({ worktreePath }) =>
                Effect.gen(function* () {
                  expect(yield* holdsWorktreeLifecycleLock(worktreePath).pipe(Effect.orDie)).toBe(
                    false,
                  );
                  preparations.push(worktreePath);
                  yield* Deferred.succeed(preparationEntered, undefined);
                  if (preparationControl.fail)
                    return yield* new PreparationError({
                      message: "setup interrupted",
                      path: worktreePath,
                    });
                  if (preparationControl.block) return yield* Effect.never;
                  const receipt = yield* receipts.latest(
                    yield* Effect.promise(() => fs.realpath(worktreePath)),
                  );
                  if (receipt) yield* receipts.update(receipt, { phase: "completed" });
                }),
            };
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(NextTurnQueueDispatcher, { notify: () => Effect.void } as never),
      ),
      Layer.provideMerge(gitLayer),
      Layer.provideMerge(base),
    );
    const layer = WorktreeSetupLive.pipe(
      Layer.provideMerge(Layer.succeed(TextGeneration, makeFakeTextGeneration())),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(transitionLayer),
    );
    const runtime = ManagedRuntime.make(layer);
    cleanups.push(() => runtime.dispose());
    const services = await runtime.runPromise(
      Effect.gen(function* () {
        return {
          transition: yield* WorkspaceTransition,
          setupService: yield* WorktreeSetup,
          engine: yield* OrchestrationEngineService,
          store: yield* WorkspaceTransitions,
          queue: yield* NextTurnQueueStore,
          config: yield* ServerConfig,
        };
      }),
    );
    if (services.config.defaultStateDir)
      await new ProfileRegistryStore(services.config.defaultStateDir).init();
    const threadId = ThreadId.makeUnsafe("thread"),
      projectId = ProjectId.makeUnsafe("project"),
      at = new Date().toISOString();
    await runtime.runPromise(
      services.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("project"),
        projectId,
        title: "Project",
        workspaceRoot: repo.root,
        defaultModel: "gpt-5-codex",
        createdAt: at,
      }),
    );
    const create = (id = threadId, branch = "main", worktreePath: string | null = null) =>
      runtime.runPromise(
        services.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create:${id}`),
          threadId: id,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch,
          worktreePath,
          createdAt: at,
        }),
      );
    await create();
    const request = async (
      intent: import("@t3tools/contracts").WorktreesSwitchWorkspaceInput["intent"],
      extra: Partial<import("@t3tools/contracts").WorktreesSwitchWorkspaceInput> = {},
    ) => {
      const thread = (await runtime.runPromise(services.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      return {
        operationId: crypto.randomUUID(),
        threadId,
        intent,
        expected: {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          sessionUpdatedAt: thread.session?.updatedAt ?? null,
        },
        ...extra,
      };
    };
    return {
      ...services,
      runtime,
      repo,
      world,
      threadId,
      projectId,
      create,
      request,
      preparations,
      failPhase,
      preparationControl,
      preparationEntered,
      mutationControl,
      mutationEntered,
      manager: await runtime.runPromise(makeWorktreeManager),
    };
  }
  it("joins identical retries, commits once, and never accepts a changed payload", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "topic");
    git(f.repo.root, "worktree", "add", "-q", "-b", "topic", target, "main");
    const input = await f.request("attach_existing", { targetPath: target, branch: "topic" });
    const [one, two] = await Promise.all([
      f.runtime.runPromise(f.transition.switchWorkspace(input)),
      f.runtime.runPromise(f.transition.switchWorkspace(input)),
    ]);
    expect(one.phase).toBe("completed");
    expect(two).toEqual(one);
    expect(await f.runtime.runPromise(f.transition.switchWorkspace(input))).toEqual(one);
    await expect(
      f.runtime.runPromise(f.transition.switchWorkspace({ ...input, branch: "changed" })),
    ).rejects.toThrow(/another request|different/);
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath).toBe(
      await fs.realpath(target),
    );
  });
  it("blocks in-place checkout for an idle archived local reference and live terminals", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const foreign = ThreadId.makeUnsafe("archived");
    await f.create(foreign);
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId: foreign,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("checkout_branch", { branch: "topic", sharedFilesystemConfirmed: true }),
      ),
    );
    expect(result.phase).toBe("failed");
    expect(result.error).toMatch(/references this checkout/);
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it.each(["checkout_branch", "create_branch_and_checkout"] as const)(
    "refuses %s when the conversation's own terminal is live",
    async (intent) => {
      const f = await fixture();
      if (intent === "checkout_branch") git(f.repo.root, "branch", "topic");
      f.world.terminals.push({
        threadId: f.threadId,
        terminalId: "own-shell",
        cwd: f.repo.root,
        status: "running",
      });
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request(intent, { branch: "topic" })),
      );
      expect(result.phase).toBe("failed");
      expect(result.errorCode).toBe("WorkspaceRequiresNewWorktree");
      expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
    },
  );

  it("requires explicit sharing confirmation and rejects external attachments", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "shared");
    git(f.repo.root, "worktree", "add", "-q", "-b", "shared", target, "main");
    await f.create(ThreadId.makeUnsafe("other"), "shared", target);
    const rejected = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    expect(rejected.phase).toBe("failed");
    expect(rejected.error).toMatch(/sharing/);
    const accepted = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, sharedFilesystemConfirmed: true }),
      ),
    );
    expect(accepted.phase).toBe("completed");
    const external = path.join(f.repo.root, "..", "external");
    git(f.repo.root, "worktree", "add", "-q", "-b", "external", external, "main");
    await expect(
      f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: external })),
      ),
    ).rejects.toThrow(/profile/);
  });
  it("creates and checks out a branch atomically, leaving a manual pause alone", async () => {
    const f = await fixture();
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "manual_pause" }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("create_branch_and_checkout", { branch: "created" }),
      ),
    );
    expect(result.error).toBeNull();
    expect(result.phase).toBe("completed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("created");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("manual_pause");
  });
  it("recovers a partial Git outcome only after preview and rejects stale acceptance tokens", async () => {
    const f = await fixture();
    const request = await f.request("checkout_branch", { branch: "topic" });
    const repository = git(f.repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const source = {
      path: await fs.realpath(f.repo.root),
      repository,
      branch: "main",
      headSha: git(f.repo.root, "rev-parse", "HEAD"),
    };
    const record = await f.runtime.runPromise(
      f.store.reserve({
        operationId: request.operationId,
        threadId: f.threadId,
        version: 0,
        intent: request.intent,
        phase: "reserved",
        request,
        requestHash: "crashed",
        source,
        target: { ...source, branch: "topic" },
        observed: null,
        fingerprint: null,
        mutationAttempted: false,
        result: null,
        error: null,
        commandId: `workspace:${request.operationId}`,
        setupOwnerToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await f.runtime.runPromise(
      f.store.update(record, { phase: "applying", mutationAttempted: true }),
    );
    git(f.repo.root, "checkout", "-qb", "topic");
    await f.runtime.runPromise(f.store.reconcile);
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    await fs.writeFile(path.join(f.repo.root, "changed.txt"), "retained");
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: record.operationId,
          version: preview.transition.version,
          acceptanceToken: preview.acceptanceToken,
          action: "accept_inspected_workspace",
        }),
      ),
    ).rejects.toThrow(/changed/);
    const fresh = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: record.operationId,
          version: fresh.transition.version,
          acceptanceToken: fresh.acceptanceToken,
          action: "retry",
        }),
      ),
    ).rejects.toThrow(/partial/);
    const result = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: record.operationId,
        version: fresh.transition.version,
        acceptanceToken: fresh.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(result.phase).toBe("completed");
    expect(await fs.readFile(path.join(f.repo.root, "changed.txt"), "utf8")).toBe("retained");
  });
  it("recreates the recorded checkout, prepares outside locks, and resumes only a missing-worktree pause", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "recovery");
    git(f.repo.root, "worktree", "add", "-q", "-b", "recovery", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, branch: "recovery" }),
      ),
    );
    await fs.rm(target, { recursive: true });
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
    );
    const before = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
    const recovered = await f.runtime.runPromise(
      f.manager.recover({
        threadId: f.threadId,
        expectedQueueRevision: before.state.revision,
        action: "recreate",
      }),
    );
    expect(recovered.registration).toBe("matching");
    expect(f.preparations).toContain(await fs.realpath(target));
    expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.paused).toBe(false);
    await fs.rm(target, { recursive: true });
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "manual_pause" }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("recreate_from_base")),
    );
    expect(result.phase).toBe("completed");
    expect(result.target.path).toBe(await fs.realpath(target));
    expect(result.target.branch).not.toBe("recovery");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("manual_pause");
  });
  it("holds a preparation failure independently of queue resume and never repeats its Git step", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "retry");
    git(f.repo.root, "worktree", "add", "-q", "-b", "retry", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.preparationControl.fail = true;
    const request = await f.request("recreate");
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("needs_recovery");
    await f.runtime.runPromise(f.queue.setPaused({ threadId: f.threadId, paused: false }));
    expect((await f.runtime.runPromise(f.store.forThread(f.threadId, true)))?.operationId).toBe(
      request.operationId,
    );
    expect(await f.runtime.runPromise(f.transition.switchWorkspace(request))).toEqual(result);
    expect(f.preparations).toHaveLength(1);
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: request.operationId }),
    );
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: request.operationId,
          version: preview.transition.version,
          acceptanceToken: preview.acceptanceToken,
          action: "retry",
        }),
      ),
    ).rejects.toThrow(/partial/);
  });
  it("rolls back the metadata transaction if completion persistence fails after Git, then accepts the inspected checkout", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.failPhase.current = "completed";
    const request = await f.request("checkout_branch", { branch: "topic" });
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("needs_recovery");
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.branch).toBe("main");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("topic");
    f.failPhase.current = null;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: request.operationId }),
    );
    const accepted = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: request.operationId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(accepted.phase).toBe("completed");
  });
  it.each(["dirty.txt", "untracked/nested.txt", "ignored/nested.txt"])(
    "rejects a preview after contents change in %s",
    async (relative) => {
      const f = await fixture();
      git(f.repo.root, "branch", "topic");
      f.failPhase.current = "applied";
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
      );
      expect(result.phase).toBe("needs_recovery");
      f.failPhase.current = null;
      const file = path.join(f.repo.root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (relative.startsWith("ignored/"))
        await fs.appendFile(path.join(f.repo.root, ".git", "info", "exclude"), "\nignored/\n");
      await fs.writeFile(file, "first");
      const preview = await f.runtime.runPromise(
        f.transition.previewRecovery({ operationId: result.operationId }),
      );
      await fs.writeFile(file, "changed contents");
      await expect(
        f.runtime.runPromise(
          f.transition.resolve({
            operationId: result.operationId,
            version: preview.transition.version,
            acceptanceToken: preview.acceptanceToken,
            action: "accept_inspected_workspace",
          }),
        ),
      ).rejects.toThrow(/changed/);
    },
  );
  it("allows archive to interrupt preparation, settle its caller, and retain checkout files", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "cancel");
    git(f.repo.root, "worktree", "add", "-q", "-b", "cancel", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.preparationControl.block = true;
    const request = await f.request("recreate");
    const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
    await f.runtime.runPromise(Deferred.await(f.preparationEntered));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-active-transition"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    expect((await running).phase).toBe("cancelled");
    expect((await f.runtime.runPromise(f.store.get(request.operationId)))?.phase).toBe("cancelled");
    expect(await fs.stat(target)).toBeDefined();
  });
  it("refuses a live terminal that opens before locked revalidation", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.world.terminals.push({
      threadId: f.threadId,
      terminalId: "shell",
      cwd: f.repo.root,
      status: "running",
    });
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it("times out waiting for the stopped session projection without holding checkout locks", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const at = new Date().toISOString();
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("idle-session"),
        threadId: f.threadId,
        session: {
          threadId: f.threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      }),
    );
    const request = await f.request("checkout_branch", { branch: "topic" });
    const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
    await vi.waitFor(async () =>
      expect((await f.runtime.runPromise(f.store.get(request.operationId)))?.phase).toBe(
        "stopping",
      ),
    );
    await f.runtime.runPromise(
      withWorktreeLifecycleLock(f.repo.root, Effect.void).pipe(Effect.timeout("1 second")),
    );
    const result = await running;
    expect(result.phase).toBe("failed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it("preserves an ignored secret when the target branch tracks the same filename", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "env-topic");
    git(f.repo.root, "worktree", "add", "-q", "-b", "env-topic", target, "main");
    await fs.writeFile(path.join(target, ".env"), "branch file");
    git(target, "add", "-f", ".env");
    git(target, "commit", "-qm", "tracked configuration");
    git(target, "checkout", "-qb", "hold-topic");
    await fs.appendFile(path.join(f.repo.root, ".git", "info", "exclude"), "\n.env\n");
    await fs.writeFile(path.join(f.repo.root, ".env"), "local secret");
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "env-topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(result.checkoutConflict?.files).toContain(".env");
    expect(await fs.readFile(path.join(f.repo.root, ".env"), "utf8")).toBe("local secret");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it("refreshes the recorded branch in the same shared checkout without confirming a new attachment", async () => {
    const f = await fixture();
    await f.create(ThreadId.makeUnsafe("archived-peer"));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-peer"),
        threadId: ThreadId.makeUnsafe("archived-peer"),
        createdAt: new Date().toISOString(),
      }),
    );
    git(f.repo.root, "checkout", "-qb", "changed-outside");
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: f.repo.root, branch: "changed-outside" }),
      ),
    );
    expect(result.phase).toBe("completed");
    expect(result.result?.branch).toBe("changed-outside");
  });

  for (const intent of ["recreate", "recreate_from_base"] as const) {
    it.each(["failure", "cancel"] as const)(
      `can leave a missing checkout after ${intent} %s without repeating Git`,
      async (outcome) => {
        const f = await fixture();
        const target = path.join(f.config.worktreesDir, "missing");
        git(f.repo.root, "worktree", "add", "-q", "-b", "missing", target, "main");
        await f.runtime.runPromise(
          f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
        );
        await fs.rm(target, { recursive: true });
        await f.runtime.runPromise(
          f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
        );
        f.mutationControl.fail = outcome === "failure";
        f.mutationControl.block = outcome === "cancel";
        const request = await f.request(intent);
        const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
        await f.runtime.runPromise(Deferred.await(f.mutationEntered));
        if (outcome === "cancel") await f.runtime.runPromise(f.transition.cancel(f.threadId, true));
        expect((await running).phase).toBe("needs_recovery");
        const preview = await f.runtime.runPromise(
          f.transition.previewRecovery({ operationId: request.operationId }),
        );
        expect(preview.actual).toBeNull();
        expect(preview.original).toBeNull();
        expect(preview.canRetry).toBe(false);
        const resolved = await f.runtime.runPromise(
          f.transition.resolve({
            operationId: request.operationId,
            version: preview.transition.version,
            acceptanceToken: preview.acceptanceToken,
            action: "use_project_checkout",
          }),
        );
        expect(resolved.phase).toBe("completed");
        expect(resolved.result?.worktreePath).toBeNull();
        expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.paused).toBe(
          false,
        );
        expect(
          await fs.stat(target).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      },
    );
    it(`${intent} does not claim a Git mutation when applying fails before its first mutating call`, async () => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "preflight");
      git(f.repo.root, "worktree", "add", "-q", "-b", "preflight", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
      );
      await fs.rm(target, { recursive: true });
      f.failPhase.current = "applying";
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request(intent)),
      );
      expect(result.phase).toBe("failed");
      expect((await f.runtime.runPromise(f.store.get(result.operationId)))?.mutationAttempted).toBe(
        false,
      );
      expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
    });
  }

  it("finishes a recovered Work locally handoff with a real setup token and replays the setup action", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "handoff");
    git(f.repo.root, "worktree", "add", "-q", "-b", "handoff", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    const at = new Date().toISOString();
    const operationId = "setup-handoff";
    const itemId = CommandId.makeUnsafe("setup-first-turn");
    const snapshot: WorktreeSetupSnapshot = {
      threadId: f.threadId,
      operationId,
      itemId,
      phase: "failed",
      startedAt: at,
      endedAt: at,
      request: {
        projectCwd: f.repo.root,
        baseBranch: "main",
        branch: "handoff",
        requireWorktree: true,
        runSetupScript: true,
      },
      baseRef: "main",
      baseSha: git(f.repo.root, "rev-parse", "HEAD"),
      worktreePath: target,
      createdBranch: false,
      createdWorktree: false,
      setupScript: null,
      agentStarted: false,
      stages: [],
      error: "setup failed",
      generation: 0,
      sequence: 1,
    };
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("seed-setup"),
        threadId: f.threadId,
        activity: {
          id: EventId.makeUnsafe(`worktree-setup:${f.threadId}`),
          kind: "worktree-setup",
          tone: "error",
          summary: "Failed setup",
          payload: snapshot,
          turnId: null,
          createdAt: at,
        },
        createdAt: at,
      }),
    );
    await f.runtime.runPromise(
      f.queue.insertSubmission({
        submissionId: itemId,
        itemId,
        atHead: true,
        requestHash: "setup",
        worktreeBlockToken: operationId,
        command: {
          type: "thread.turn.start",
          commandId: itemId,
          threadId: f.threadId,
          message: {
            messageId: MessageId.makeUnsafe("message"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: at,
        },
      }),
    );
    await f.runtime.runPromise(
      f.queue.setPaused({
        threadId: f.threadId,
        paused: true,
        reasonCode: "worktree_setup_failed",
      }),
    );
    f.failPhase.current = "completed";
    await expect(
      f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId)),
    ).rejects.toThrow();
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.worktreeBlockToken,
    ).toBe(operationId);
    f.failPhase.current = null;
    const transitionId = `work-locally:${operationId}`;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: transitionId }),
    );
    const result = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: transitionId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(result.phase).toBe("completed");
    expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state).toMatchObject({
      worktreeBlockToken: null,
      paused: false,
    });
    const settled = await f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId));
    expect(settled?.phase).toBe("cancelled_kept");
    expect(await fs.stat(target)).toBeTruthy();
    expect(await f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId))).toEqual(
      settled,
    );
  });
  it("retries indeterminate async preparation after its old setup token was cleared, preserving the existing setup pause", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "async-restart");
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const gitCore = yield* GitCore;
        const receipts = yield* WorktreePreparations;
        yield* gitCore.createWorktree({
          cwd: f.repo.root,
          branch: "main",
          newBranch: "async-restart",
          path: target,
          preparation: { owner: "workflow:async", runSetupScript: true },
        });
        const receipt = (yield* gitCore.readWorktreePreparation(target))!;
        yield* receipts.update(receipt, { phase: "setup_running", result: '{"async":true}' });
        yield* receipts.reconcile;
      }),
    );
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await f.runtime.runPromise(
      f.queue.setPaused({
        threadId: f.threadId,
        paused: true,
        reasonCode: "worktree_setup_failed",
      }),
    );
    expect(
      (await f.runtime.runPromise(f.manager.threadState({ threadId: f.threadId }))).recovery,
    ).toBe("interrupted");
    const queue = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
    const state = await f.runtime.runPromise(
      f.manager.recover({
        threadId: f.threadId,
        action: "recreate",
        expectedQueueRevision: queue.state.revision,
      }),
    );
    expect(state.recovery).toBe("none");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("worktree_setup_failed");
  });
});
