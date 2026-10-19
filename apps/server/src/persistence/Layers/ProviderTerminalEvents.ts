import { EventId, ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProviderTerminalEventReceipt,
  ProviderTerminalEventRepository,
  type ProviderTerminalEventRepositoryShape,
} from "../Services/ProviderTerminalEvents.ts";

const DbRow = ProviderTerminalEventReceipt.mapFields(
  Struct.assign({
    event: Schema.fromJsonString(ProviderRuntimeEvent),
  }),
);

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record: ProviderTerminalEventRepositoryShape["record"] = (event) =>
    Effect.gen(function* () {
      const eventJson = yield* Schema.encodeEffect(Schema.fromJsonString(ProviderRuntimeEvent))(
        event,
      );
      yield* sql`
        INSERT OR IGNORE INTO provider_terminal_events (
          event_id,
          thread_id,
          turn_id,
          event_type,
          event_json,
          received_at,
          applied_at,
          attempt,
          last_error, origin_provider_instance_id, origin_session_generation, origin_turn_id, next_due_at
        ) VALUES (
          ${event.eventId},
          ${event.threadId},
          ${event.turnId ?? null},
          ${event.type},
          ${eventJson},
          ${new Date().toISOString()},
          NULL,
          0,
          NULL, ${event.providerInstanceId ?? null}, ${event.sessionGeneration ?? null}, ${event.turnId ?? null}, ${new Date().toISOString()}
        )
      `;
    }).pipe(Effect.mapError(mapError("ProviderTerminalEventRepository.record")));

  const columns = sql`event_id AS "eventId", thread_id AS "threadId", turn_id AS "turnId",
    event_type AS "eventType", event_json AS "event", received_at AS "receivedAt",
    applied_at AS "appliedAt", attempt, last_error AS "lastError",
    origin_provider_instance_id AS "originProviderInstanceId",
    origin_session_generation AS "originSessionGeneration", origin_turn_id AS "originTurnId",
    next_due_at AS "nextDueAt"`;

  const markFailed: ProviderTerminalEventRepositoryShape["markFailed"] = (input) =>
    sql`
    UPDATE provider_terminal_events
    SET attempt = attempt + 1, last_error = ${input.error.slice(0, 4096)},
      next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now',
        ('+' || MIN(30.0, (1 << MIN(attempt, 5)) * ${0.8 + Math.random() * 0.4}) || ' seconds'))
    WHERE event_id = ${input.eventId} AND applied_at IS NULL
  `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTerminalEventRepository.markFailed")));

  // Decode independently: one corrupt legacy row cannot block the remaining page.
  const decodePage = (rows: ReadonlyArray<Record<string, unknown>>) =>
    Effect.forEach(
      rows,
      (row) =>
        Schema.decodeUnknownEffect(DbRow)(row).pipe(
          Effect.map((receipt) => [receipt]),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              if (typeof row.eventId === "string")
                yield* markFailed({
                  eventId: EventId.makeUnsafe(row.eventId),
                  error: String(cause),
                });
              yield* Effect.logWarning("invalid provider terminal receipt; retry deferred", {
                eventId: row.eventId,
                cause,
              });
              return [];
            }),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.map((pages) => pages.flat()));

  const listPending: ProviderTerminalEventRepositoryShape["listPending"] = sql<
    Record<string, unknown>
  >`
    SELECT ${columns} FROM provider_terminal_events WHERE applied_at IS NULL
    ORDER BY next_due_at, received_at, event_id LIMIT 64
  `.pipe(
    Effect.flatMap(decodePage),
    Effect.mapError(mapError("ProviderTerminalEventRepository.listPending")),
  );
  const listDue: ProviderTerminalEventRepositoryShape["listDue"] = (
    now = new Date().toISOString(),
  ) =>
    sql<Record<string, unknown>>`
    SELECT ${columns} FROM provider_terminal_events WHERE applied_at IS NULL AND next_due_at <= ${now}
    ORDER BY next_due_at, received_at, event_id LIMIT 64
  `.pipe(
      Effect.flatMap(decodePage),
      Effect.mapError(mapError("ProviderTerminalEventRepository.listDue")),
    );
  const hasPending: ProviderTerminalEventRepositoryShape["hasPending"] = (threadId, turnId) =>
    sql`
    SELECT 1 FROM provider_terminal_events WHERE applied_at IS NULL
      AND thread_id = ${threadId} AND (turn_id = ${turnId} OR turn_id IS NULL) LIMIT 1
  `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapError("ProviderTerminalEventRepository.hasPending")),
    );

  const markApplied: ProviderTerminalEventRepositoryShape["markApplied"] = (eventId) =>
    sql`
      UPDATE provider_terminal_events
      SET applied_at = COALESCE(applied_at, ${new Date().toISOString()}),
          last_error = NULL
      WHERE event_id = ${eventId}
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTerminalEventRepository.markApplied")));

  return {
    record,
    listPending,
    listDue,
    hasPending,
    markApplied,
    markFailed,
  } satisfies ProviderTerminalEventRepositoryShape;
});

export const ProviderTerminalEventRepositoryLive = Layer.effect(
  ProviderTerminalEventRepository,
  make,
);
