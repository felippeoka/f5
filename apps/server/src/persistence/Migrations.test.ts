import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { LATEST_MIGRATION_ID, MIGRATIONS, runMigrations } from "./Migrations.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";
import scheduledMigration from "./Migrations/127_ScheduledTasks.ts";

describe("MIGRATIONS", () => {
  // The migrator only runs IDs above the highest one a database has applied,
  // so a gap is permanent: a migration that later fills it never runs on any
  // database that already has the higher one.
  it("numbers migrations 1..latest without gaps or duplicates", () => {
    const ids = Object.keys(MIGRATIONS)
      .map((key) => Number.parseInt(key, 10))
      .toSorted((left, right) => left - right);
    expect(ids).toEqual(Array.from({ length: LATEST_MIGRATION_ID }, (_, index) => index + 1));
  });
});

for (const legacySchedules of [false, true]) {
  effectIt.effect(
    `upgrades ${legacySchedules ? "the original schedules 124" : "main 126"} without losing durable evidence`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const preceding = Object.fromEntries(
          Object.entries(MIGRATIONS).filter(
            ([key]) => Number.parseInt(key, 10) <= (legacySchedules ? 123 : 126),
          ),
        );
        if (legacySchedules) preceding["124_ScheduledTasks"] = scheduledMigration;
        yield* Migrator.make({})({ loader: Migrator.fromRecord(preceding) });
        yield* sql`INSERT INTO provider_terminal_events(event_id,thread_id,turn_id,event_type,event_json,received_at,attempt) VALUES('receipt','thread','turn','turn.completed','{}','2026-10-01',2)`;
        if (legacySchedules) {
          yield* sql`INSERT INTO scheduled_tasks(id,project_id,definition_json,request_hash,requested_at,version,enabled,updated_at) VALUES('task','project','{}','hash','2026-10-01',1,1,'2026-10-01')`;
          yield* sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,thread_id,owns_execution,capacity,created_at) VALUES('run','task','2026-10-01','manual','pending','{}','{}','thread',1,1,'2026-10-01')`;
          yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind) VALUES('submission','run','thread','message','initial')`;
        }
        yield* runMigrations;
        yield* runMigrations;
        expect(
          yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id>=124 ORDER BY migration_id`,
        ).toEqual([
          { migration_id: 124, name: "ProviderTerminalRetry" },
          { migration_id: 125, name: "ProviderTerminalRetryIndexes" },
          { migration_id: 126, name: "ProviderTerminalRecoveryIndexes" },
          { migration_id: 127, name: "ScheduledTasks" },
        ]);
        expect(
          yield* sql`SELECT event_id,attempt,origin_session_generation,next_due_at IS NOT NULL AS retry FROM provider_terminal_events`,
        ).toEqual([{ event_id: "receipt", attempt: 2, origin_session_generation: null, retry: 1 }]);
        const indexes = yield* sql<{ name: string }>`PRAGMA index_list(provider_terminal_events)`;
        expect(indexes.some((index) => index.name === "provider_terminal_events_retry_age")).toBe(
          true,
        );
        expect(
          yield* sql`SELECT s.submission_id,owns_execution,capacity FROM scheduled_run_submissions s JOIN scheduled_task_runs r ON s.run_id=r.id`,
        ).toEqual(
          legacySchedules ? [{ submission_id: "submission", owns_execution: 1, capacity: 1 }] : [],
        );
      }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
  );
}

effectIt.layer(SqliteClient.layerMemory())("migration upgrades", (it) => {
  it.effect("adds session capabilities after database compaction has already run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const previousMigrations = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 107),
      );
      yield* Migrator.make({})({ loader: Migrator.fromRecord(previousMigrations) });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      expect(before.some((column) => column.name === "capabilities_json")).toBe(false);
      const compaction = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 107
      `;
      expect(compaction).toEqual([{ name: "DatabaseCompaction" }]);

      yield* runMigrations;
      yield* runMigrations;

      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      expect(after.filter((column) => column.name === "capabilities_json")).toHaveLength(1);
      const capabilities = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 108
      `;
      expect(capabilities).toEqual([{ name: "ProjectionThreadSessionCapabilities" }]);
    }),
  );
});

effectIt.layer(SqliteClient.layerMemory())("usage account history upgrade", (it) => {
  it.effect("creates usage history tables on a database already at 115", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const throughDeliveryEvidence = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 115),
      );
      yield* Migrator.make({})({ loader: Migrator.fromRecord(throughDeliveryEvidence) });
      const tables = () => sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN (
          'usage_account_snapshots', 'usage_quota_samples', 'usage_quota_samples_sampled_idx'
        )
        ORDER BY name
      `;
      expect(yield* tables()).toEqual([]);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 115`).toEqual([
        { name: "DeliveryHistoryEvidence" },
      ]);

      yield* runMigrations;
      yield* runMigrations;

      expect((yield* tables()).map((row) => row.name)).toEqual([
        "usage_account_snapshots",
        "usage_quota_samples",
        "usage_quota_samples_sampled_idx",
      ]);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 116`).toEqual([
        { name: "UsageAccountHistory" },
      ]);
    }),
  );
});
