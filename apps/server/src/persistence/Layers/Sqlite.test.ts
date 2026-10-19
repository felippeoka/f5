import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

describe("SQLite persistence setup", () => {
  it.each([false, true])(
    "applies durable bounded-WAL settings after migrations (existing=%s)",
    async (existing) => {
      const directory = mkdtempSync(join(tmpdir(), "f5-sqlite-setup-"));
      const filename = join(directory, "state.sqlite");
      if (existing) {
        const database = new DatabaseSync(filename);
        database.exec(
          "CREATE TABLE planner_fixture(value TEXT); CREATE INDEX planner_fixture_index ON planner_fixture(value); INSERT INTO planner_fixture VALUES('one'),('two');",
        );
        database.close();
      }
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            expect((yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0]?.timeout).toBe(5000);
            expect(
              (yield* sql<{ checkpoint_fullfsync: number }>`PRAGMA checkpoint_fullfsync`)[0]
                ?.checkpoint_fullfsync,
            ).toBe(1);
            expect((yield* sql<{ synchronous: number }>`PRAGMA synchronous`)[0]?.synchronous).toBe(
              2,
            );
            expect(
              (yield* sql<{ journal_size_limit: number }>`PRAGMA journal_size_limit`)[0]
                ?.journal_size_limit,
            ).toBe(33554432);
            expect(
              (yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`)[0]?.foreign_keys,
            ).toBe(1);
            if (existing) {
              const stats = yield* sql<{
                tbl: string;
              }>`SELECT tbl FROM sqlite_stat1 WHERE tbl='planner_fixture'`;
              expect(stats).toHaveLength(1);
            }
          }).pipe(
            Effect.provide(
              makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
