import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Metric } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { sqlConnectionWaitDuration, sqlExecutionDuration } from "../observability/Metrics.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";
import { withReadTransaction } from "./sqliteTransactions.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("sets a busy timeout on the physical connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
      assert.equal(rows[0]?.timeout, 5000);
    }),
  );

  it.effect("uses durable checkpoints without relaxing synchronous writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ checkpoint_fullfsync: number }>`PRAGMA checkpoint_fullfsync`)[0]
          ?.checkpoint_fullfsync,
        1,
      );
      assert.equal((yield* sql<{ synchronous: number }>`PRAGMA synchronous`)[0]?.synchronous, 2);
    }),
  );

  it.effect("does not cache a prepare failure after the missing table is created", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = sql`SELECT name FROM created_after_failure`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(query)));
      yield* sql`CREATE TABLE created_after_failure(name TEXT)`;
      yield* sql`INSERT INTO created_after_failure VALUES ('recovered')`;
      assert.deepEqual(yield* query, [{ name: "recovered" }]);
      assert.deepEqual(yield* query.values, [["recovered"]]);
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
  it.effect("records statement execution and connection wait durations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const count = (metric: typeof sqlExecutionDuration) =>
        Metric.value(metric).pipe(Effect.map((state) => state.count));
      const succeeded = Metric.withAttributes(sqlExecutionDuration, { outcome: "success" });
      const executedBefore = yield* count(succeeded);
      const waitedBefore = yield* count(sqlConnectionWaitDuration);

      yield* sql`SELECT 1`;
      yield* sql`SELECT 1`.values;
      yield* sql.withTransaction(sql`SELECT 1`);

      // Three SELECTs plus the transaction's BEGIN and COMMIT, each timed once.
      assert.equal((yield* count(succeeded)) - executedBefore, 5);
      assert.isAtLeast((yield* count(sqlConnectionWaitDuration)) - waitedBefore, 3);
    }),
  );
  it.effect("records failed statements on the row and positional paths", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const failed = Metric.withAttributes(sqlExecutionDuration, { outcome: "failure" });
      const failedBefore = (yield* Metric.value(failed)).count;
      yield* sql`CREATE TABLE failing_fixture(id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO failing_fixture(id) VALUES (1)`;

      const duplicate = sql`INSERT INTO failing_fixture(id) VALUES (1)`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(duplicate)));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(duplicate.values)));

      assert.equal((yield* Metric.value(failed)).count - failedBefore, 2);
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

it.effect("reserves the write lock before a transaction reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "f5-sqlite-lock-"));
  const filename = join(directory, "state.sqlite");
  const other = new DatabaseSync(filename);
  other.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)",
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{ value: number }>`SELECT value FROM counter`;
        assert.throws(() => other.exec("UPDATE counter SET value=1"), /locked/);
        yield* sql`UPDATE counter SET value=${row!.value + 10}`;
      }),
    );
    other.exec("UPDATE counter SET value=value+1");
    assert.deepEqual(yield* sql`SELECT value FROM counter`.values, [[11]]);
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename })),
    Effect.ensuring(
      Effect.sync(() => {
        other.close();
        rmSync(directory, { recursive: true, force: true });
      }),
    ),
  );
});

it.effect("a read transaction keeps its snapshot while another connection writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "f5-sqlite-read-"));
  const filename = join(directory, "state.sqlite");
  const other = new DatabaseSync(filename);
  other.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)",
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withReadTransaction(sql)(
      Effect.gen(function* () {
        assert.deepEqual(yield* sql`SELECT value FROM counter`.values, [[0]]);
        other.exec("UPDATE counter SET value=1");
        yield* withReadTransaction(sql)(sql`SELECT value FROM counter`).pipe(
          Effect.map((rows) => assert.deepEqual(rows, [{ value: 0 }])),
        );
        assert.deepEqual(yield* sql`SELECT value FROM counter`.values, [[0]]);
      }),
    );
    assert.deepEqual(yield* sql`SELECT value FROM counter`.values, [[1]]);
    yield* Effect.exit(withReadTransaction(sql)(Effect.fail("read canceled")));
    yield* sql.withTransaction(sql`UPDATE counter SET value=2`);
    assert.deepEqual(yield* sql`SELECT value FROM counter`.values, [[2]]);
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename })),
    Effect.ensuring(
      Effect.sync(() => {
        other.close();
        rmSync(directory, { recursive: true, force: true });
      }),
    ),
  );
});

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-sqlite-prepare-"));
    const filename = join(directory, "state.sqlite");
    const blocker = new DatabaseSync(filename);
    blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The production default is tested separately; the failed attempt here must
      // return immediately so this exercises cache invalidation rather than a wait.
      yield* sql`PRAGMA busy_timeout=1`;
      blocker.exec("BEGIN EXCLUSIVE");
      const query = sql`SELECT value FROM entries`;
      const failure = yield* Effect.exit(query.values);
      assert.isTrue(Exit.isFailure(failure));
      blocker.exec("ROLLBACK");
      assert.deepEqual(yield* query.values, [["retained"]]);
      assert.deepEqual(yield* query, [{ value: "retained" }]);
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename })),
      Effect.ensuring(
        Effect.sync(() => {
          blocker.close();
          rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );
  },
);
