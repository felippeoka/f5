import type { OrchestrationCommand } from "@t3tools/contracts";
import { OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import { scheduledContinuationFor } from "../scheduledTasks/continuations.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { requireAttachmentOwner } from "../attachmentOwnership.ts";
import { canonicalRequestHash } from "../nextTurnQueue/canonicalRequestHash.ts";
import type { NextTurnQueueStoreShape } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import type { WorkspaceTransitionsShape } from "../persistence/Services/WorkspaceTransitions.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Queue pauses the user or environment chose, which a conversation revert must not undo. */
const QUEUE_PAUSES_KEPT_ACROSS_REVERT: ReadonlySet<string> = new Set([
  "manual_pause",
  "thread_archived",
  "worktree_missing",
]);

/** All calls run inside the engine's existing command/event transaction. */
export function makeCommitSideEffects({
  sql,
  transitions,
  queueStore,
}: {
  readonly sql: SqlClient.SqlClient;
  readonly transitions: Option.Option<Pick<WorkspaceTransitionsShape, "cancel">>;
  readonly queueStore: Option.Option<Pick<NextTurnQueueStoreShape, "insertSubmission">>;
}) {
  return (
    savedEvent: OrchestrationEvent,
    {
      commandType,
      steerFallback,
    }: {
      readonly commandType: OrchestrationCommand["type"];
      readonly steerFallback: boolean;
    },
  ) =>
    Effect.gen(function* () {
      if (savedEvent.type === "thread.archived" || savedEvent.type === "thread.deleted") {
        if (Option.isSome(transitions))
          yield* transitions.value.cancel(savedEvent.payload.threadId).pipe(Effect.orDie);
      }
      if (savedEvent.type === "thread.archived") {
        // Startup repair can precede queue subscribers. Persist the pause
        // with the archive so a restart cannot dispatch an archived child.
        yield* sql`INSERT INTO next_turn_queue_state
        (thread_id, paused, pause_reason_code, pause_detail, revision, updated_at)
        VALUES (${savedEvent.payload.threadId}, 1, 'thread_archived',
          'Queue paused because the thread was archived.', 1, ${savedEvent.occurredAt})
        ON CONFLICT(thread_id) DO UPDATE SET
          paused = 1,
          pause_reason_code = CASE WHEN paused = 1 THEN pause_reason_code ELSE 'thread_archived' END,
          pause_detail = CASE WHEN paused = 1 THEN pause_detail ELSE 'Queue paused because the thread was archived.' END,
          revision = revision + 1, updated_at = ${savedEvent.occurredAt}`;
      }
      if (
        savedEvent.type === "thread.session-stop-requested" ||
        savedEvent.type === "thread.archived" ||
        (savedEvent.type === "thread.turn-interrupt-requested" &&
          savedEvent.payload.turnId === undefined)
      ) {
        yield* sql`UPDATE provider_turn_deliveries SET state = 'rejected', certainty = 'not_sent',
        error_code = 'cancelled_before_send', error_detail = 'The session stopped before this turn was sent.',
        updated_at = ${savedEvent.occurredAt}
        WHERE thread_id = ${savedEvent.payload.threadId} AND state = 'pending'`;
      }
      if (
        savedEvent.type === "thread.session-stop-requested" ||
        savedEvent.type === "thread.archived"
      ) {
        // Commit cancellation with the stop intent: a crash before live
        // subscribers run must never revive an unsent continuation.
        yield* sql`UPDATE usage_limit_resumes SET state = 'cancelled',
        updated_at = ${savedEvent.occurredAt}
        WHERE thread_id = ${savedEvent.payload.threadId} AND state = 'scheduled'`;
        const cancelled = yield* sql<{ submissionId: string }>`
        UPDATE next_turn_queue SET deleted_at = ${savedEvent.occurredAt},
          updated_at = ${savedEvent.occurredAt}
        WHERE thread_id = ${savedEvent.payload.threadId}
          AND schedule_reason = 'usage_limit_reset'
          AND status = 'queued' AND deleted_at IS NULL
        RETURNING submission_id AS "submissionId"
      `;
        for (const item of cancelled) {
          yield* sql`UPDATE turn_submissions SET disposition = 'canceled',
          reason_code = ${savedEvent.type === "thread.archived" ? "thread_archived" : "session_stopped"}, settled_at = ${savedEvent.occurredAt}
          WHERE submission_id = ${item.submissionId} AND disposition IN ('pending', 'queued')`;
        }
        if (cancelled.length > 0)
          yield* sql`UPDATE next_turn_queue_state SET revision = revision + 1,
          updated_at = ${savedEvent.occurredAt} WHERE thread_id = ${savedEvent.payload.threadId}`;
      }
      if (savedEvent.type === "thread.message-sent") {
        yield* Effect.forEach(
          savedEvent.payload.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              yield* sql`
              DELETE FROM attachment_owners
              WHERE attachment_id = ${attachment.id}
                AND owner_kind IN ('ingress', 'queue_item')
            `;
              yield* requireAttachmentOwner(
                sql,
                attachment.id,
                "message",
                savedEvent.payload.messageId,
                savedEvent.occurredAt,
              );
            }),
          { concurrency: 1, discard: true },
        );
      }
      if (
        savedEvent.type === "thread.turn-start-requested" ||
        savedEvent.type === "thread.turn-steer-requested"
      ) {
        const eventJson = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent))(savedEvent);
        if (steerFallback)
          yield* sql`UPDATE provider_turn_deliveries SET event_json = ${eventJson}, state = 'pending', provider_turn_id = NULL, attempt = 0, error_code = NULL, error_detail = NULL, certainty = NULL, not_before = NULL, outcome_projected_at = NULL WHERE command_id = ${savedEvent.commandId} AND state = 'rejected' AND certainty = 'not_sent'`;
        yield* sql`
        INSERT OR IGNORE INTO provider_turn_deliveries (
          delivery_id, thread_id, command_id, message_id, state, attempt,
          pre_send_turn_ids_json, event_json, created_at, updated_at
        ) VALUES (
          ${savedEvent.commandId}, ${savedEvent.payload.threadId},
          ${savedEvent.commandId}, ${savedEvent.payload.messageId}, 'pending', 0,
          '[]', ${eventJson}, ${savedEvent.occurredAt}, ${savedEvent.occurredAt}
        )
      `;
      }
      if (savedEvent.type === "thread.user-input-resolved") {
        const command = savedEvent.payload.command;
        if (command) {
          if (Option.isNone(queueStore))
            return yield* new OrchestrationCommandInvariantError({
              commandType,
              detail: "The durable answer queue is unavailable.",
            });
          const sourceInput = yield* sql<{
            turn_id: string | null;
          }>`SELECT json_extract(payload_json,'$.turnId') AS turn_id FROM projection_pending_user_inputs WHERE thread_id=${savedEvent.payload.threadId} AND request_id=${savedEvent.payload.requestId}`;
          const scheduledRun = yield* scheduledContinuationFor(
            savedEvent.payload.threadId,
            sourceInput[0]?.turn_id,
            "user_input",
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (error) =>
                new OrchestrationCommandInvariantError({ commandType, detail: error.message }),
            ),
          );
          yield* queueStore.value
            .insertSubmission({
              scheduledRun,
              submissionId: command.commandId,
              itemId: command.commandId,
              requestHash: canonicalRequestHash(command),
              command,
              atHead: command.expectedTurnId !== undefined,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new OrchestrationCommandInvariantError({
                    commandType,
                    detail: error.message,
                  }),
              ),
            );
          for (const attachment of savedEvent.payload.attachments ?? [])
            yield* sql`DELETE FROM attachment_owners WHERE attachment_id = ${attachment.id} AND owner_kind = 'ingress' AND owner_id = ${savedEvent.commandId}`;
        } else
          for (const attachment of savedEvent.payload.attachments ?? []) {
            yield* sql`DELETE FROM attachment_owners WHERE attachment_id = ${attachment.id} AND owner_kind = 'ingress' AND owner_id = ${savedEvent.commandId}`;
            yield* requireAttachmentOwner(
              sql,
              attachment.id,
              "user_input",
              savedEvent.payload.requestId,
              savedEvent.occurredAt,
            );
          }
      }
      if (savedEvent.type === "thread.rewind-draft-resolved") {
        const { operationId, threadId } = savedEvent.payload;
        if (savedEvent.payload.intent === "cancel") {
          // Cancel an untouched rewind, or an uncertain native file rewind explicitly acknowledged after stopping the provider.
          // Prepared rewinds have not changed provider history. Give the prompt's attachments back to its
          // message, restore the queue, and unblock the thread. Deleting the
          // request row also stops a Retry still queued behind the rewind
          // gate, and a run that already loaded the operation loses its
          // conditional claim of `provider-pending` against this delete.
          const pending = (yield* sql<{
            target_message_id: string;
          }>`SELECT target_message_id FROM rewind_operations WHERE operation_id = ${operationId} AND thread_id = ${threadId} AND (state = 'prepared' OR (mode = 'conversation-and-files' AND state = 'reconciliation-required' AND EXISTS (SELECT 1 FROM native_operations WHERE operation_id = ${`native-files:${operationId}`} AND thread_id = ${threadId} AND state = 'cancelled')))`)[0];
          if (!pending)
            return yield* new OrchestrationCommandInvariantError({
              commandType,
              detail:
                "This rewind is already in progress or finished and can no longer be cancelled.",
            });
          const draftOwners = yield* sql<{
            attachmentId: string;
          }>`SELECT attachment_id AS "attachmentId" FROM attachment_owners WHERE owner_kind = 'rewind_draft' AND owner_id = ${operationId}`;
          for (const owner of draftOwners)
            yield* requireAttachmentOwner(
              sql,
              owner.attachmentId,
              "message",
              pending.target_message_id,
              savedEvent.occurredAt,
            );
          yield* sql`DELETE FROM attachment_owners WHERE owner_kind = 'rewind_draft' AND owner_id = ${operationId}`;
          const saved = (yield* sql<{
            state: string | null;
          }>`SELECT queue_state_json AS state FROM rewind_requests WHERE operation_id = ${operationId}`)[0];
          const prior = saved?.state
            ? (JSON.parse(saved.state) as {
                paused: number;
                pause_reason_code: string | null;
                pause_detail: string | null;
              })
            : { paused: 0, pause_reason_code: null, pause_detail: null };
          // Only the pauses this rewind set; another pause (for example a
          // checkpoint revert) must survive the cancel.
          yield* sql`UPDATE next_turn_queue_state SET paused = ${prior.paused}, pause_reason_code = ${prior.pause_reason_code}, pause_detail = ${prior.pause_detail}, revision = revision + 1 WHERE thread_id = ${threadId} AND pause_reason_code IN ('rewind_in_progress', 'reconciliation_required')`;
          yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${operationId}`;
          yield* sql`DELETE FROM rewind_operations WHERE operation_id = ${operationId}`;
        } else {
          const draft =
            yield* sql`SELECT operation_id FROM rewind_operations WHERE operation_id = ${operationId} AND thread_id = ${threadId} AND state = 'completed'`;
          if (!draft.length)
            return yield* new OrchestrationCommandInvariantError({
              commandType,
              detail: "This rewind draft is not ready.",
            });
          yield* sql`DELETE FROM attachment_owners WHERE owner_kind = 'rewind_draft' AND owner_id = ${operationId} AND attachment_id IN (SELECT attachment_id FROM attachments WHERE thread_id = ${threadId})`;
          yield* sql`UPDATE rewind_operations SET draft_resolved_at = ${savedEvent.occurredAt} WHERE operation_id = ${operationId} AND thread_id = ${threadId} AND state = 'completed'`;
        }
      }
      if (savedEvent.type === "thread.reverted" && savedEvent.payload.operationId) {
        const { operationId, threadId } = savedEvent.payload;
        yield* sql`DELETE FROM restart_turn_markers WHERE thread_id = ${threadId}`;
        const saved = (yield* sql<{
          state: string | null;
        }>`SELECT queue_state_json AS state FROM rewind_requests WHERE operation_id = ${operationId}`)[0];
        const prior = saved?.state
          ? (JSON.parse(saved.state) as {
              paused: number;
              pause_reason_code: string | null;
              pause_detail: string | null;
            })
          : { paused: 0, pause_reason_code: null, pause_detail: null };
        const queued =
          yield* sql`SELECT 1 FROM next_turn_queue WHERE thread_id = ${threadId} AND deleted_at IS NULL LIMIT 1`;
        // A pause the user or the environment chose outlives the revert. Pauses
        // about turns (failed, interrupted, ...) described turns the revert just
        // deleted, so they go. Queued prompts were written against the discarded
        // conversation and wait for review; with nothing queued the queue runs.
        const next =
          prior.paused &&
          prior.pause_reason_code !== null &&
          QUEUE_PAUSES_KEPT_ACROSS_REVERT.has(prior.pause_reason_code)
            ? prior
            : queued.length > 0
              ? { paused: 1, pause_reason_code: "thread_reverted", pause_detail: null }
              : { paused: 0, pause_reason_code: null, pause_detail: null };
        // Only replaces the pause this rewind set; one set meanwhile survives.
        yield* sql`UPDATE next_turn_queue_state SET paused = ${next.paused}, pause_reason_code = ${next.pause_reason_code}, pause_detail = ${next.pause_detail}, revision = revision + 1 WHERE thread_id = ${threadId} AND pause_reason_code IN ('rewind_in_progress', 'reconciliation_required')`;
        yield* sql`UPDATE rewind_operations SET state = 'completed', updated_at = ${savedEvent.occurredAt} WHERE operation_id = ${savedEvent.payload.operationId} AND thread_id = ${savedEvent.payload.threadId} AND state = 'files-confirmed'`;
        yield* sql`DELETE FROM rewind_requests WHERE operation_id = ${savedEvent.payload.operationId}`;
      }
      if (savedEvent.type === "thread.conversation-revert-requested") {
        const priorQueueState =
          (yield* sql`SELECT paused, pause_reason_code, pause_detail FROM next_turn_queue_state WHERE thread_id = ${savedEvent.payload.threadId}`)[0] ?? {
            paused: 0,
            pause_reason_code: null,
            pause_detail: null,
          };
        yield* sql`INSERT OR IGNORE INTO rewind_requests(operation_id, thread_id, payload_json, created_at, queue_state_json) VALUES (${savedEvent.payload.operationId}, ${savedEvent.payload.threadId}, ${JSON.stringify(savedEvent.payload)}, ${savedEvent.occurredAt}, ${JSON.stringify(priorQueueState)})`;
        yield* sql`INSERT INTO next_turn_queue_state(thread_id, paused, pause_reason_code, revision, updated_at) VALUES (${savedEvent.payload.threadId}, 1, 'rewind_in_progress', 1, ${savedEvent.occurredAt}) ON CONFLICT(thread_id) DO UPDATE SET paused = 1, pause_reason_code = 'rewind_in_progress', revision = revision + 1`;
      }
    });
}
