/**
 * Native command identity: F5 mints the provider command id before the first
 * send and stores it, so every retry of one F5 delivery reuses it and the
 * host's command-id dedupe joins the original outcome.
 *
 * @module provider/msp/nativeCommandIds
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export interface NativeCommandIdStore {
  readonly resolve: (input: {
    readonly providerInstanceId: string;
    readonly f5CommandId: string;
    readonly mint: () => string;
  }) => Effect.Effect<string>;
}

export function sqlNativeCommandIdStore(sql: SqlClient.SqlClient): NativeCommandIdStore {
  return {
    resolve: ({ providerInstanceId, f5CommandId, mint }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO provider_native_command_ids
              (f5_command_id, provider_instance_id, native_command_id, created_at)
              VALUES (${f5CommandId}, ${providerInstanceId}, ${mint()}, ${new Date().toISOString()})`;
            const rows = yield* sql<{ readonly native_command_id: string }>`
              SELECT native_command_id FROM provider_native_command_ids
              WHERE f5_command_id = ${f5CommandId}`;
            const stored = rows[0]?.native_command_id;
            if (!stored) return yield* Effect.die(new Error("native command id was not stored"));
            return stored;
          }),
        )
        .pipe(Effect.orDie),
  };
}

/** For hosts without persistence (tests, text generation). */
export function memoryNativeCommandIdStore(): NativeCommandIdStore {
  const ids = new Map<string, string>();
  return {
    resolve: ({ f5CommandId, mint }) =>
      Effect.sync(() => {
        const existing = ids.get(f5CommandId);
        if (existing) return existing;
        const minted = mint();
        ids.set(f5CommandId, minted);
        return minted;
      }),
  };
}
