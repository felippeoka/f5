import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { threadPurgePolicy, threadPurgeHandlers } from "./threadPurgePolicy.ts";

it.layer(SqlitePersistenceMemory)("thread purge schema coverage", (it) => {
  it.effect("classifies every migrated table with thread_id and verifies cascades", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      const unclassified: string[] = [];
      for (const table of tables) {
        const columns = yield* sql<{
          name: string;
        }>`SELECT name FROM pragma_table_info(${table.name})`;
        if (!columns.some((column) => column.name === "thread_id")) continue;
        const policy = threadPurgePolicy[table.name];
        if (!policy) {
          unclassified.push(table.name);
          continue;
        }
        if (policy.kind === "explicit")
          assert.isTrue(
            table.name in threadPurgeHandlers,
            `${table.name} needs an explicit SQL deletion handler`,
          );
        if (policy.kind === "retain") assert.isNotEmpty(policy.reason);
        if (policy.kind === "cascade") {
          const keys = yield* sql<{
            table: string;
            from: string;
            on_delete: string;
          }>`SELECT * FROM pragma_foreign_key_list(${table.name})`;
          assert.isTrue(
            keys.some(
              (key) =>
                key.table === "projection_threads" &&
                key.from === "thread_id" &&
                key.on_delete === "CASCADE",
            ),
            `${table.name} must cascade from projection_threads`,
          );
        }
      }
      assert.deepStrictEqual(unclassified, []);
    }),
  );
});
