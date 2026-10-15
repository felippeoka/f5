import { ensureProviderTurnDeliveriesSchema } from "./ProviderTurnDeliveriesSchema";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureProviderTurnDeliveriesSchema;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('provider_turn_deliveries')`;
  if (!columns.some((column) => column.name === "history_evidence_json"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN history_evidence_json TEXT`;
  if (!columns.some((column) => column.name === "attempt_id"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN attempt_id TEXT`;
  if (!columns.some((column) => column.name === "reservation_released_at"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN reservation_released_at TEXT`;
  if (!columns.some((column) => column.name === "acceptance_receipt_json"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN acceptance_receipt_json TEXT`;
  yield* sql`UPDATE provider_turn_deliveries SET reservation_released_at = updated_at WHERE state IN ('rejected', 'abandoned')`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_delivery_thread_state_due ON provider_turn_deliveries(thread_id, state, not_before, created_at)`;
});
