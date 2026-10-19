import { assert, it } from "@effect/vitest";
import { EventId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderTerminalEventRepositoryLive } from "../Layers/ProviderTerminalEvents.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { ProviderTerminalEventRepository } from "../Services/ProviderTerminalEvents.ts";
import * as NodeSqlite from "../NodeSqliteClient.ts";
import createLegacyReceipts from "./074_ProviderTerminalEvents.ts";
import addRetry from "./124_ProviderTerminalRetry.ts";
import addIndexes from "./125_ProviderTerminalRetryIndexes.ts";

it.layer(NodeSqlite.layerMemory())("terminal retry migration", (it) => {
  it.effect("rolls back interrupted upgrades and preserves the legacy read contract", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createLegacyReceipts;
      yield* sql`INSERT INTO provider_terminal_events(event_id, thread_id, turn_id, event_type, event_json, received_at, attempt) VALUES ('legacy', 'thread', 'turn', 'turn.completed', '{}', '2026-10-01', 0)`;
      const interrupted = yield* sql
        .withTransaction(addRetry.pipe(Effect.andThen(Effect.fail("interrupted"))))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(interrupted));
      const before = yield* sql<{ name: string }>`PRAGMA table_info(provider_terminal_events)`;
      assert.isFalse(before.some((column) => column.name === "next_due_at"));
      yield* sql.withTransaction(addRetry.pipe(Effect.andThen(addIndexes)));
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, attempt, last_error FROM provider_terminal_events`,
        [{ event_id: "legacy", attempt: 0, last_error: null }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT origin_session_generation, origin_turn_id FROM provider_terminal_events`,
        [{ origin_session_generation: null, origin_turn_id: null }],
      );
      const indexes = yield* sql<{ name: string }>`PRAGMA index_list(provider_terminal_events)`;
      assert.isTrue(indexes.some((index) => index.name === "provider_terminal_events_due"));
      assert.isTrue(
        indexes.some((index) => index.name === "provider_terminal_events_pending_thread"),
      );
    }),
  );
});

it.layer(ProviderTerminalEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "bounded terminal retries",
  (it) => {
    it.effect(
      "pages through pending receipts, isolates malformed rows and retains origin identity",
      () =>
        Effect.gen(function* () {
          const repository = yield* ProviderTerminalEventRepository;
          const sql = yield* SqlClient.SqlClient;
          const event = (index: number) => ({
            type: "turn.completed" as const,
            eventId: EventId.makeUnsafe(`page-${String(index).padStart(3, "0")}`),
            provider: "codex" as const,
            providerInstanceId: ProviderInstanceId.makeUnsafe("codex-test"),
            sessionGeneration: 7,
            threadId: ThreadId.makeUnsafe(`thread-${index}`),
            turnId: TurnId.makeUnsafe(`turn-${index}`),
            createdAt: "2026-10-19T12:00:00.000Z",
            payload: { state: "completed" as const },
          });
          for (let index = 0; index < 130; index++) yield* repository.record(event(index));
          yield* sql`UPDATE provider_terminal_events SET event_json = 'invalid' WHERE event_id = 'page-000'`;
          const first = yield* repository.listDue("9999-12-31T00:00:00.000Z");
          assert.equal(first.length, 63);
          assert.equal(first[0]?.originSessionGeneration, 7);
          assert.equal(first[0]?.originProviderInstanceId, "codex-test");
          assert.equal(first[0]?.originTurnId, "turn-1");
          assert.isTrue(
            yield* repository.hasPending(
              ThreadId.makeUnsafe("thread-129"),
              TurnId.makeUnsafe("turn-129"),
            ),
          );
          for (const receipt of first) yield* repository.markApplied(receipt.eventId);
          const second = yield* repository.listDue();
          assert.equal(second.length, 64);
          for (const receipt of second) yield* repository.markApplied(receipt.eventId);
          assert.equal((yield* repository.listDue()).length, 2);
          const malformed = yield* sql<{
            attempt: number;
            nextDue: string;
            appliedAt: string | null;
          }>`SELECT attempt, next_due_at AS nextDue, applied_at AS appliedAt FROM provider_terminal_events WHERE event_id = 'page-000'`;
          assert.equal(malformed[0]?.attempt, 1);
          assert.equal(malformed[0]?.appliedAt, null);
          assert.isTrue(Date.parse(malformed[0]!.nextDue) > Date.now());
        }),
    );
  },
);
