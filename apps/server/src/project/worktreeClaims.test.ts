import { WorktreePreparations } from "../persistence/Services/WorktreePreparations.ts";
import { ThreadId } from "@t3tools/contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ServerConfig } from "../config.ts";
import {
  automationLayer,
  makeWorld,
  makeClonedRepo,
  git,
  project,
  thread,
} from "../storage/storageAutomation.testHarness.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../git/testDoubles.ts";
import {
  evaluateWorktreeRemoval,
  readWorktreeClaims,
  removeWorktreeSafely,
} from "./worktreeClaims.ts";

describe("effective workspace claims and removal gate", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  it("checks the reviewed root identity under both locks before removal", async () => {
    const repo = await makeClonedRepo("f5-root-identity-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const target = path.join(config.worktreesDir, "identity");
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }));
        git(repo.root, "worktree", "add", "-q", "-b", "identity", target, "main");
        const stat = yield* Effect.promise(() => fs.lstat(target));
        const input = {
          projectCwd: repo.root,
          path: target,
          policy: { kind: "manual" as const, ownThreadId: null },
        };
        const refused = yield* removeWorktreeSafely({
          ...input,
          expectedRootIdentity: { dev: stat.dev, ino: stat.ino + 1 },
        });
        expect(refused.blockedReasons.join(" ")).toContain("replaced since inspection");
        expect((yield* Effect.promise(() => fs.lstat(target))).isDirectory()).toBe(true);
        const removed = yield* removeWorktreeSafely({
          ...input,
          expectedRootIdentity: { dev: stat.dev, ino: stat.ino },
        });
        expect(removed.blockedReasons).toEqual([]);
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-root-identity-state-")), Effect.scoped),
    );
  });
  it("includes local and archived conversations, and treats canonicalization failure as unknown", async () => {
    const repo = await makeClonedRepo("f5-claims-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    world.threads.push(thread({ id: "local", projectId: "p", worktreePath: null }));
    world.threads.push({
      ...thread({ id: "archived", projectId: "p", worktreePath: null }),
      archivedAt: new Date().toISOString(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const claims = yield* readWorktreeClaims(repo.root);
        expect(claims.threadIds).toEqual(["local", "archived"]);
        expect(claims.unknown).toBe(false);
        expect((yield* readWorktreeClaims("/bad\0path")).unknown).toBe(true);
        world.threads.push(thread({ id: "unknown", projectId: "p", worktreePath: "/bad\0path" }));
        expect((yield* readWorktreeClaims(repo.root)).unknown).toBe(true);
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-claims-state-")), Effect.scoped),
    );
  });
  it("allows idle links but blocks ignored secrets, queued work, and live orphan processes", async () => {
    const repo = await makeClonedRepo("f5-removal-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const target = path.join(config.worktreesDir, "repo", "feature");
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }));
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        world.threads.push(
          thread({ id: "idle", projectId: "p", worktreePath: target, branch: "feature" }),
        );
        const inspect = () =>
          evaluateWorktreeRemoval({
            projectCwd: repo.root,
            path: target,
            policy: { kind: "manual", ownThreadId: null },
          });
        expect((yield* inspect()).blockedReasons).toEqual([]);
        expect((yield* inspect()).linkedThreads).toEqual(["idle"]);
        world.sessions.push({ threadId: "idle", cwd: target, status: "ready" });
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("stop that session");
        world.sessions.length = 0;
        yield* Effect.promise(() => fs.writeFile(path.join(target, ".env"), "SECRET=value\n"));
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("ignored");
        yield* Effect.promise(() => fs.rm(path.join(target, ".env")));
        yield* Effect.promise(() =>
          fs.mkdir(path.join(target, "node_modules", "dep"), { recursive: true }),
        );
        expect((yield* inspect()).blockedReasons).toEqual([]);
        world.queuedThreadIds.add("idle");
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("queued");
        world.queuedThreadIds.clear();
        world.terminals.push({
          threadId: "orphan",
          terminalId: "shell",
          cwd: target,
          status: "running",
        });
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("terminal");
        world.terminals.length = 0;
        world.projects.push(project("other", target));
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("project checkout");
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-removal-state-")), Effect.scoped),
    );
  });
  it("manual removal preserves ignored databases, envrc files, and private keys", async () => {
    const repo = await makeClonedRepo("f5-manual-ignored-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* GitCore;
        const target = path.join((yield* ServerConfig).worktreesDir, "manual");
        yield* core.createWorktree({
          cwd: repo.root,
          branch: "main",
          newBranch: "manual",
          path: target,
        });
        yield* Effect.promise(() =>
          fs.appendFile(
            path.join(repo.root, ".git", "info", "exclude"),
            "\n*.sqlite\n.envrc\n*.pem\n",
          ),
        );
        for (const name of ["local.sqlite", ".envrc", "private.pem"]) {
          yield* Effect.promise(() => fs.writeFile(path.join(target, name), "precious local data"));
          const result = yield* removeWorktreeSafely({
            projectCwd: repo.root,
            path: target,
            policy: { kind: "manual", ownThreadId: null },
          });
          expect(result.blockedReasons.join(" ")).toContain("ignored");
          const raw = yield* Effect.result(core.removeWorktree({ cwd: repo.root, path: target }));
          expect(raw._tag).toBe("Failure");
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, name), "utf8"))).toBe(
            "precious local data",
          );
          yield* Effect.promise(() => fs.rm(path.join(target, name)));
        }
      }).pipe(
        Effect.provide(automationLayer(world, {}, "f5-manual-ignored-state-")),
        Effect.scoped,
      ),
    );
  });

  it.each(["pr:feature", "workflow:implementation"])(
    "removes idle pending preparation owned by %s and releases its reservation",
    async (owner) => {
      const repo = await makeClonedRepo("f5-pending-removal-");
      cleanups.push(repo.cleanup);
      const world = makeWorld();
      world.projects.push(project("p", repo.root));
      await Effect.runPromise(
        Effect.gen(function* () {
          const gitCore = yield* GitCore;
          const target = path.join((yield* ServerConfig).worktreesDir, "pending");
          yield* gitCore.createWorktree({
            cwd: repo.root,
            branch: "main",
            newBranch: "pending",
            path: target,
            preparation: { owner, runSetupScript: true },
          });
          expect((yield* gitCore.readWorktreePreparation(target))?.phase).toBe("checkout_created");
          const receipts = yield* WorktreePreparations;
          const pending = (yield* gitCore.readWorktreePreparation(target))!;
          const interrupted = yield* receipts.update(pending, { phase: "setup_indeterminate" });
          expect(
            (yield* evaluateWorktreeRemoval({
              projectCwd: repo.root,
              path: target,
              policy: { kind: "manual", ownThreadId: null },
            })).blockedReasons.join(" "),
          ).toContain("preparation operation owns");
          yield* receipts.update(interrupted, { phase: "checkout_created" });
          const result = yield* removeWorktreeSafely({
            projectCwd: repo.root,
            path: target,
            policy: { kind: "manual", ownThreadId: null },
          });
          expect(result.blockedReasons).toEqual([]);
          expect((yield* gitCore.readWorktreePreparation(target))?.phase).toBe("skipped");
          yield* gitCore.createWorktree({
            cwd: repo.root,
            branch: "pending",
            path: target,
            preparation: { owner, runSetupScript: true },
          });
          expect((yield* gitCore.readWorktreePreparation(target))?.phase).toBe("checkout_created");
        }).pipe(
          Effect.provide(automationLayer(world, {}, "f5-pending-removal-state-")),
          Effect.scoped,
        ),
      );
    },
  );
  it("releases a failed add only after proving no checkout or registration was created", async () => {
    const repo = await makeClonedRepo("f5-add-failure-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    await Effect.runPromise(
      Effect.gen(function* () {
        const gitCore = yield* GitCore;
        const target = path.join((yield* ServerConfig).worktreesDir, "failed-add");
        git(repo.root, "branch", "existing");
        const failed = yield* gitCore
          .createWorktree({ cwd: repo.root, branch: "main", newBranch: "existing", path: target })
          .pipe(Effect.exit);
        expect(failed._tag).toBe("Failure");
        expect((yield* gitCore.readWorktreePreparation(target))?.phase).toBe("skipped");
        yield* gitCore.createWorktree({ cwd: repo.root, branch: "existing", path: target });
        expect(git(target, "branch", "--show-current")).toBe("existing");
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-add-failure-state-")), Effect.scoped),
    );
  });

  it("blocks initialized submodules in both preview and removal, preserving their files", async () => {
    const repo = await makeClonedRepo("f5-submodule-removal-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const target = path.join((yield* ServerConfig).worktreesDir, "submodules");
        git(repo.root, "worktree", "add", "-q", "-b", "submodules", target, "main");
        git(target, "-c", "protocol.file.allow=always", "submodule", "add", repo.root, "child");
        git(target, "commit", "-qm", "add submodule");
        const input = {
          projectCwd: repo.root,
          path: target,
          policy: { kind: "manual" as const, ownThreadId: null },
        };
        expect((yield* evaluateWorktreeRemoval(input)).blockedReasons.join(" ")).toContain(
          "initialized submodules",
        );
        const removed = yield* removeWorktreeSafely(input);
        expect(removed.blockedReasons.join(" ")).toContain("initialized submodules");
        expect(
          yield* Effect.promise(() => fs.stat(path.join(target, "child", ".git"))),
        ).toBeDefined();
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-submodule-state-")), Effect.scoped),
    );
  }, 60_000);

  it("uses the default branch for maintenance when a new worktree has no upstream", async () => {
    const repo = await makeClonedRepo("f5-maintenance-base-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const target = path.join((yield* ServerConfig).worktreesDir, "no-upstream");
        git(repo.root, "worktree", "add", "-q", "-b", "no-upstream", target, "main");
        const inspect = () =>
          evaluateWorktreeRemoval({
            projectCwd: repo.root,
            path: target,
            policy: { kind: "storageMaintenance", ownThreadId: null },
          });
        expect((yield* inspect()).blockedReasons).toEqual([]);
        git(target, "commit", "--allow-empty", "-qm", "unpublished");
        expect((yield* inspect()).blockedReasons).toContain(
          "unpushed commits could not be ruled out",
        );
      }).pipe(
        Effect.provide(automationLayer(world, {}, "f5-maintenance-base-state-")),
        Effect.scoped,
      ),
    );
  });

  it("rejects an outside path before running any Git commands", async () => {
    const fake = makeFakeGitCore();
    await Effect.runPromise(
      evaluateWorktreeRemoval({
        projectCwd: "/repo",
        path: process.cwd(),
        policy: { kind: "manual", ownThreadId: null },
      }).pipe(
        Effect.provideService(GitCore, fake.service),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.blockedReasons).toContain("outside the allowed worktrees root");
            expect(result.exists).toBe(false);
          }),
        ),
        Effect.provide(automationLayer(makeWorld(), {}, "f5-outside-state-")),
        Effect.scoped,
      ),
    );
    expect(Object.values(fake.calls).flat()).toEqual([]);
  });

  it("retains rollback checkouts with setup output, unproven ownership, or live owned terminals", async () => {
    const repo = await makeClonedRepo("f5-rollback-gate-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* GitCore;
        const target = path.join((yield* ServerConfig).worktreesDir, "owned");
        yield* core.createWorktree({
          cwd: repo.root,
          branch: "main",
          newBranch: "owned",
          path: target,
          preparation: { owner: "thread:owner" },
        });
        const owner = thread({
          id: "owner",
          projectId: "p",
          worktreePath: target,
          branch: "owned",
        });
        world.threads.push(owner);
        const proof = {
          path: target,
          commonDir: yield* core.resolveCommonDir(repo.root),
          baseSha: git(target, "rev-parse", "HEAD"),
          created: true,
        };
        const remove = (created = true, ownThreadId = owner.id) =>
          removeWorktreeSafely({
            projectCwd: repo.root,
            path: target,
            policy: {
              kind: "ownedRollback",
              ownThreadId,
              ownedCreation: { ...proof, created },
            },
          });
        expect((yield* remove(false)).blockedReasons.join(" ")).toContain("ownership");
        expect(
          (yield* remove(true, ThreadId.makeUnsafe("other-owner"))).blockedReasons.join(" "),
        ).toContain("ownership");
        yield* Effect.promise(() => fs.writeFile(path.join(target, "setup-output"), "keep"));
        expect((yield* remove()).blockedReasons.join(" ")).toContain("uncommitted");
        yield* Effect.promise(() => fs.rm(path.join(target, "setup-output")));
        world.terminals.push({
          threadId: owner.id,
          terminalId: "setup",
          cwd: target,
          status: "running",
        });
        expect((yield* remove()).blockedReasons.join(" ")).toContain("terminal");
        world.terminals.length = 0;
        expect((yield* remove()).blockedReasons).toEqual([]);
        expect(
          yield* Effect.promise(() =>
            fs.access(target).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-rollback-gate-state-")), Effect.scoped),
    );
  });
});
