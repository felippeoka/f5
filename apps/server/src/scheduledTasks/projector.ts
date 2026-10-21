import { fenceScheduledRun } from "./cancellation.ts";
import type { OrchestrationEvent, ScheduledTaskRun } from "@t3tools/contracts";
import { Effect } from "effect";
import { makeScheduledTaskStore, type ScheduledTaskStoreShape } from "./Store.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

export const SCHEDULED_RUN_EVENT_TYPES: ReadonlyArray<OrchestrationEvent["type"]> = [
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.turn-processing-quiesced",
  "thread.activity-appended",
  "thread.user-input-resolved",
  "thread.deleted",
  "thread.archived",
  "thread.message-sent",
];
/** Filtered, checkpointed by ProjectionPipeline. Operational state is never rebuilt from unrelated turns. */
export const makeScheduledRunProjector =
  (store: ScheduledTaskStoreShape) => (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (!SCHEDULED_RUN_EVENT_TYPES.includes(event.type)) return;
      const { sql } = store;
      const rows = yield* sql<{
        id: string;
        last_event_sequence: number;
      }>`SELECT id,last_event_sequence FROM scheduled_task_runs WHERE thread_id=${event.aggregateId} AND owns_execution=1`;
      const row = rows[0];
      if (!row || row.last_event_sequence >= event.sequence) return;
      const current = yield* store.run(row.id);
      if (!current) return;
      const hasContinuation = (turnId: string) =>
        sql`SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${row.id} AND parent_submission_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${row.id} AND turn_id=${turnId}) AND recovery_decision='continue'`.pipe(
          Effect.map((rows) => rows.length > 0),
        );
      let status: ScheduledTaskRun["status"] | null = null;
      let reason: ScheduledTaskRun["reason"] = null;
      switch (event.type) {
        case "thread.deleted":
        case "thread.archived": {
          const safe = yield* fenceScheduledRun(row.id, event.occurredAt);
          status = safe ? "failed" : "needs_attention";
          reason = "thread_removed";
          break;
        }
        case "thread.session-set": {
          const session = event.payload.session;
          if (session.status === "running" && session.activeTurnId) {
            if (yield* hasContinuation(session.activeTurnId)) break;
            const turns = yield* sql<{
              pending_message_id: string | null;
            }>`SELECT pending_message_id FROM projection_turns WHERE thread_id=${event.payload.threadId} AND turn_id=${session.activeTurnId}`;
            const associated =
              yield* sql`SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${row.id} AND (message_id=${turns[0]?.pending_message_id ?? null} OR turn_id=${session.activeTurnId})`;
            if (associated.length) {
              yield* sql`UPDATE scheduled_task_runs SET turn_id=${session.activeTurnId} WHERE id=${row.id}`;
              yield* sql`UPDATE scheduled_run_submissions SET turn_id=${session.activeTurnId} WHERE run_id=${row.id} AND message_id=${turns[0]?.pending_message_id ?? null}`;
              status = "running";
            }
          } else if (
            event.payload.settledTurnId &&
            event.payload.settledTurnId === current.turnId
          ) {
            if (yield* hasContinuation(event.payload.settledTurnId)) break;
            if (session.usageLimit) {
              status = "needs_attention";
              reason = "usage_limit";
            } else if (session.status === "error") {
              status = "failed";
              reason = "delivery_failed";
            } else if (session.status === "stopped") {
              status = "needs_attention";
              reason = "interrupted";
            }
          }
          break;
        }
        case "thread.turn-diff-completed":
        case "thread.turn-processing-quiesced": {
          if (event.payload.turnId !== current.turnId) break;
          if (yield* hasContinuation(event.payload.turnId)) break;
          // Checkpoints describe diff availability, not whether the provider turn succeeded.
          const outcome = (yield* sql<{
            state: string;
            processing_quiesced_at: string | null;
          }>`SELECT state,processing_quiesced_at FROM projection_turns WHERE thread_id=${event.aggregateId} AND turn_id=${event.payload.turnId}`)[0];
          if (
            current.run.reason === "interrupted" ||
            current.run.reason === "usage_limit" ||
            current.run.reason === "recovery_pending"
          )
            break;
          if (outcome?.state === "completed" && outcome.processing_quiesced_at)
            status = "succeeded";
          if (outcome?.state === "error") {
            status = "failed";
            reason = "delivery_failed";
          }
          if (outcome?.state === "interrupted") {
            status = "needs_attention";
            reason = "interrupted";
          }
          break;
        }
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          if (!current.turnId || (activity.turnId && activity.turnId !== current.turnId)) break;
          if (yield* hasContinuation(current.turnId)) break;
          if (activity.kind === "approval.requested") {
            status = "needs_attention";
            reason = "approval";
          }
          if (activity.kind === "user-input.requested") {
            status = "needs_attention";
            reason = "user_input";
          }
          if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
            const approvals =
              yield* sql`SELECT request_id FROM projection_pending_approvals WHERE thread_id=${event.aggregateId} AND status='pending'`;
            const inputs =
              yield* sql`SELECT request_id FROM projection_pending_user_inputs WHERE thread_id=${event.aggregateId} AND resolution IS NULL`;
            if (!approvals.length && !inputs.length) status = "running";
          }
          break;
        }
      }
      yield* sql`UPDATE scheduled_task_runs SET last_event_sequence=${event.sequence} WHERE id=${row.id}`;
      if (status) yield* store.transition(row.id, status, reason, event.occurredAt);
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionPipeline.scheduledTaskRuns")));

/** Convenience entry point for isolated projector tests. Production constructs once. */
export const projectScheduledRunEvent = (event: OrchestrationEvent) =>
  Effect.flatMap(makeScheduledTaskStore, (store) => makeScheduledRunProjector(store)(event));
