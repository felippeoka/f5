import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MIGRATIONS } from "./Migrations.ts";

/** Opt-in repair for known development builds; never part of normal server startup. */
export const repairUnreleasedScheduledTaskMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tracking =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='effect_sql_migrations'`;
  if (!tracking.length) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const previous = yield* sql<{
        migration_id: number;
      }>`SELECT migration_id FROM effect_sql_migrations
      WHERE migration_id IN(124,127,128) AND name='ScheduledTasks' ORDER BY migration_id`;
      for (const row of previous) {
        const replacement = Object.entries(MIGRATIONS).find(
          ([key]) =>
            Number.parseInt(key, 10) === row.migration_id && !key.endsWith("_ScheduledTasks"),
        );
        if (!replacement) continue;
        const [key, migration] = replacement;
        yield* migration;
        const name = key.slice(key.indexOf("_") + 1);
        yield* sql`UPDATE effect_sql_migrations SET name=${name} WHERE migration_id=${row.migration_id} AND name='ScheduledTasks'`;
      }
    }),
  );
});
