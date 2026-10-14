import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("sets a busy timeout on the physical connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
      assert.equal(rows[0]?.timeout, 5000);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );
  it.effect("preserves raw write metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE raw_write_fixture(id INTEGER PRIMARY KEY, value TEXT)`;
      const metadata = yield* sql`INSERT INTO raw_write_fixture(value) VALUES (${"synthetic"})`.raw;
      assert.deepEqual(metadata, { changes: 1, lastInsertRowid: 1 });
    }),
  );
  for (const values of [false, true]) {
    it.effect(
      `fully executes zero-column incremental vacuum with positional values=${values}`,
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const table = values ? "vacuum_values_fixture" : "vacuum_rows_fixture";
          yield* sql`PRAGMA auto_vacuum=INCREMENTAL`;
          yield* sql`VACUUM`;
          yield* sql.unsafe(`CREATE TABLE ${table}(value BLOB)`);
          yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<256)
          INSERT INTO ${table} SELECT zeroblob(4000) FROM n
        `);
          yield* sql.unsafe(`DELETE FROM ${table}`);
          const before = yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`;
          assert.isAbove(before[0]!.freelist_count, 100);
          const vacuum = sql`PRAGMA incremental_vacuum(100000)`;
          assert.deepEqual(yield* values ? vacuum.values : vacuum, []);
          const after = yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`;
          assert.equal(after[0]!.freelist_count, 0);
          yield* sql.unsafe(`DROP TABLE ${table}`);
        }),
    );
  }
});
