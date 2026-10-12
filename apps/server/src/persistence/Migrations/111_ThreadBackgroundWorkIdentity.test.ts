import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0066 from "./066_ThreadBackgroundWork.ts";
import Migration0111 from "./111_ThreadBackgroundWorkIdentity.ts";

it.layer(SqliteClient.layerMemory())("111_ThreadBackgroundWorkIdentity", (it) => {
  it.effect("adds identity columns and backfills kind idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;
      yield* Migration0066;

      const insert = (workItemId: string, ownership: string, phase: string | null) => sql`
        INSERT INTO projection_thread_background_work (
          thread_id, provider_work_item_id, provider_name, classification, ownership,
          status, active, phase, started_at, updated_at, last_seen_at
        ) VALUES (
          'thread-1', ${workItemId}, 'claudeAgent', 'working', ${ownership},
          'completed', 0, ${phase},
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* insert("shell", "direct-subagent", "local_bash");
      yield* insert("monitor", "direct-subagent", "monitor");
      yield* insert("workflow", "workflow", "local_workflow");
      yield* insert("agent", "direct-subagent", "Explore");
      yield* insert("untyped", "direct-subagent", null);

      yield* Migration0111;
      yield* Migration0111;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_background_work')
      `;
      const names = new Set(columns.map((column) => column.name));
      for (const column of ["kind", "title", "prompt", "last_tool", "dismissed_at"]) {
        assert.equal(names.has(column), true, column);
      }

      const kinds = yield* sql<{ readonly workItemId: string; readonly kind: string }>`
        SELECT provider_work_item_id AS "workItemId", kind
        FROM projection_thread_background_work
        ORDER BY provider_work_item_id
      `;
      assert.deepStrictEqual(kinds, [
        { workItemId: "agent", kind: "agent" },
        { workItemId: "monitor", kind: "shell" },
        { workItemId: "shell", kind: "shell" },
        { workItemId: "untyped", kind: "agent" },
        { workItemId: "workflow", kind: "workflow" },
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_thread_background_work'
      `;
      assert.equal(
        indexes.some((index) => index.name === "projection_thread_background_work_visible_idx"),
        true,
      );
    }),
  );

  it.effect("is a no-op when the projection table does not exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS projection_thread_background_work`;
      yield* Migration0111;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_background_work'
      `;
      assert.deepStrictEqual(tables, []);
    }),
  );
});
