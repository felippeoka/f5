import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Stable identity for background work: a kind, a title and the original
 * prompt written once at start, the most recent tool kept apart from the task
 * type, and a dismissal marker that hides settled work from the agents panel.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_background_work')
  `;
  if (existing.length === 0) return;
  const columns = new Set(existing.map((column) => column.name));

  if (!columns.has("kind")) {
    yield* sql`
      ALTER TABLE projection_thread_background_work
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (kind IN ('agent', 'shell', 'workflow'))
    `;
    yield* sql`
      UPDATE projection_thread_background_work
      SET kind = CASE
        WHEN ownership = 'workflow' THEN 'workflow'
        WHEN phase IN ('monitor', 'monitor_mcp', 'local_bash', 'shell') THEN 'shell'
        ELSE 'agent'
      END
    `;
  }
  if (!columns.has("title")) {
    yield* sql`ALTER TABLE projection_thread_background_work ADD COLUMN title TEXT`;
  }
  if (!columns.has("prompt")) {
    yield* sql`ALTER TABLE projection_thread_background_work ADD COLUMN prompt TEXT`;
  }
  if (!columns.has("last_tool")) {
    yield* sql`ALTER TABLE projection_thread_background_work ADD COLUMN last_tool TEXT`;
  }
  if (!columns.has("dismissed_at")) {
    yield* sql`ALTER TABLE projection_thread_background_work ADD COLUMN dismissed_at TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_thread_background_work_visible_idx
    ON projection_thread_background_work(thread_id, dismissed_at, active, updated_at)
  `;
});
