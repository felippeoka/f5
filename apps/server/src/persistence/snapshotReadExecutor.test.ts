import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  SnapshotReadClients,
  SnapshotReadDeadline,
  withSnapshotRead,
} from "./snapshotReadExecutor.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-snapshot-readers-"));
  roots.push(root);
  return makeSqlitePersistenceLive(Path.join(root, "state.sqlite"));
}

it("pins a background view while writes and foreground reads continue independently", async () => {
  const persistence = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* SqlClient.SqlClient;
        const readers = yield* SnapshotReadClients;
        expect(readers.foreground).not.toBe(readers.background);
        for (const client of [writer, readers.foreground, readers.background]) {
          const timeout = yield* client<{ timeout: number }>`PRAGMA busy_timeout`;
          expect(timeout[0]?.timeout).toBe(5_000);
        }
        yield* writer`CREATE TABLE reader_probe (sequence INTEGER, value TEXT)`;
        yield* writer`INSERT INTO reader_probe VALUES (1, 'before')`;
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const background = yield* withSnapshotRead(
          readers.background,
          "background",
          Effect.gen(function* () {
            const sequence = yield* readers.background<{
              sequence: number;
            }>`SELECT sequence FROM reader_probe`;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            const rows = yield* readers.background<{
              value: string;
            }>`SELECT value FROM reader_probe`;
            return { sequence: sequence[0]!.sequence, value: rows[0]!.value };
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* writer.withTransaction(
          writer`UPDATE reader_probe SET sequence = 2, value = 'after'`,
        );
        const foreground = yield* withSnapshotRead(
          readers.foreground,
          "foreground",
          readers.foreground<{ value: string }>`SELECT value FROM reader_probe`,
        );
        expect(foreground[0]!.value).toBe("after");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(background)).toEqual({ sequence: 1, value: "before" });
        const checkpoint = yield* writer`PRAGMA wal_checkpoint(PASSIVE)`;
        expect(checkpoint.length).toBe(1);
      }).pipe(Effect.provide(persistence.pipe(Layer.provideMerge(NodeServices.layer)))),
    ),
  );
});

it("rejects reader writes, releases cancelled transactions and reports retryable expiry", async () => {
  const persistence = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* SqlClient.SqlClient,
          readers = yield* SnapshotReadClients;
        yield* writer`CREATE TABLE cancellation_probe (value INTEGER)`;
        expect(
          Exit.isFailure(
            yield* Effect.exit(readers.foreground`INSERT INTO cancellation_probe VALUES (1)`),
          ),
        ).toBe(true);
        const entered = yield* Deferred.make<void>();
        const fiber = yield* withSnapshotRead(
          readers.foreground,
          "foreground",
          Effect.gen(function* () {
            yield* readers.foreground`SELECT * FROM cancellation_probe`;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const expired = yield* Effect.exit(
          withSnapshotRead(
            readers.foreground,
            "foreground",
            readers.foreground`SELECT 1`.pipe(Effect.provideService(SnapshotReadDeadline, -1)),
          ),
        );
        expect(Exit.isFailure(expired)).toBe(true);
        if (Exit.isFailure(expired))
          expect(String(expired.cause)).toContain("SnapshotReadExecutor");
        yield* withSnapshotRead(readers.foreground, "foreground", readers.foreground`SELECT 1`);
        yield* writer`INSERT INTO cancellation_probe VALUES (2)`;
      }).pipe(Effect.provide(persistence.pipe(Layer.provideMerge(NodeServices.layer)))),
    ),
  );
});

it("keeps in-memory snapshots on the writer database", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* SqlClient.SqlClient,
          readers = yield* SnapshotReadClients;
        expect(readers.foreground).toBe(writer);
        expect(readers.background).toBe(writer);
        yield* writer`CREATE TABLE memory_probe (value INTEGER)`;
        yield* writer`INSERT INTO memory_probe VALUES (7)`;
        const rows = yield* withSnapshotRead(
          readers.foreground,
          "foreground",
          readers.foreground<{ value: number }>`SELECT value FROM memory_probe`,
        );
        expect(rows[0]!.value).toBe(7);
        // A memory-layer caller may already own the only database connection.
        const nested = yield* writer.withTransaction(
          withSnapshotRead(
            readers.foreground,
            "foreground",
            writer<{ value: number }>`SELECT value FROM memory_probe`,
            false,
          ),
        );
        expect(nested[0]!.value).toBe(7);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    ),
  );
});

it("binds the real snapshot repository graph to readers even inside a writer transaction", async () => {
  const persistence = await fixture();
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(NodeServices.layer),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* SqlClient.SqlClient;
        const snapshots = yield* ProjectionSnapshotQuery;
        yield* writer.withTransaction(
          Effect.gen(function* () {
            yield* writer`INSERT INTO projection_projects(project_id, title, workspace_root, default_model, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('uncommitted-project', 'Project', '/tmp/project', 'gpt-5-codex', '[]', '2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z', NULL)`;
            expect((yield* snapshots.getSnapshot()).projects).toEqual([]);
          }),
        );
        expect((yield* snapshots.getSnapshot()).projects.map((project) => project.id)).toEqual([
          "uncommitted-project",
        ]);
      }).pipe(Effect.provide(layer)),
    ),
  );
});
