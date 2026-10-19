import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('projection_threads')`).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("settled_at"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_at TEXT`;
  if (!columns.has("last_unsettled_at"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN last_unsettled_at TEXT`;
  if (!columns.has("settled_by"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_by TEXT CHECK(settled_by IS NULL OR settled_by IN ('user','auto','agent'))`;
  if (!columns.has("auto_settle_disabled"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN auto_settle_disabled INTEGER NOT NULL DEFAULT 0 CHECK(auto_settle_disabled IN (0,1))`;
  yield* sql`CREATE INDEX IF NOT EXISTS projection_threads_settled ON projection_threads(project_id,settled_at) WHERE settled_at IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_message_authorship (
    message_id TEXT PRIMARY KEY REFERENCES projection_thread_messages(message_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('human','automation'))
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_settlement_requests (thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE, turn_id TEXT NOT NULL, requested_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_settlement_hooks (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    job_id TEXT NOT NULL, settled_at TEXT NOT NULL, worktree_path TEXT NOT NULL,
    project_id TEXT NOT NULL, scripts_json TEXT NOT NULL CHECK(length(CAST(scripts_json AS BLOB))<=65536),
    state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','canceled','orphaned')),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_settlement_hooks_worktree ON thread_settlement_hooks(worktree_path,state)`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_settlement_hooks_active ON thread_settlement_hooks(state) WHERE state IN ('pending','running','orphaned')`;
  // Missing historical provenance remains possibly human. Only positive evidence excludes a message.
  yield* sql`INSERT OR IGNORE INTO thread_message_authorship(message_id,thread_id,source)
    SELECT m.message_id,m.thread_id,'automation' FROM provider_submission_provenance p
    JOIN orchestration_events e ON e.command_id=p.command_id AND e.stream_id=p.thread_id AND e.event_type='thread.message-sent'
    JOIN projection_thread_messages m ON m.message_id=json_extract(e.payload_json,'$.messageId') AND m.thread_id=p.thread_id
    JOIN projection_threads t ON t.thread_id=m.thread_id
    WHERE p.source='automation' AND m.role='user'`;
});
