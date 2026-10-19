import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";
import { withImmediateTransactions } from "../sqliteTransactions.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly disableWAL?: boolean;
  readonly checkpointWorker?: boolean;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    // Bun otherwise enables WAL while opening the connection, before our busy timeout.
    const layer = clientModule.layer({
      ...config,
      disableWAL: true,
      checkpointWorker: runtime === "node",
    });
    return runtime === "bun"
      ? Layer.effect(
          SqlClient.SqlClient,
          Effect.map(Effect.service(SqlClient.SqlClient), withImmediateTransactions),
        ).pipe(Layer.provide(layer))
      : layer;
  }).pipe(Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    // Takes effect only before the first table exists, so new databases start
    // incremental; an existing one switches at its next VACUUM (see
    // storage/databaseSpace.ts).
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_size_limit = 33554432;`;
    yield* runMigrations;
    yield* sql`PRAGMA optimize = 0x10012;`;
  }),
);

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: dbPath }));
  }).pipe(Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig;
  return makeSqlitePersistenceLive(dbPath);
}).pipe(Layer.unwrap);
