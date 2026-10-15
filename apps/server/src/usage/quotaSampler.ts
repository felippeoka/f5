import { Cause, Clock, Duration, Effect, Exit } from "effect";
import type * as Semaphore from "effect/Semaphore";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { AccountHistoryRecorder } from "./accountHistory.ts";

export const QUOTA_SAMPLER_INITIAL_DELAY = Duration.minutes(1);
export const QUOTA_SAMPLER_INTERVAL = Duration.minutes(10);
export const QUOTA_SAMPLER_PROBE_TIMEOUT = Duration.minutes(2);
export const QUOTA_SAMPLE_RETENTION_MS = 35 * 24 * 60 * 60_000;
const BACKOFF_BASE_MINUTES = 10;
const BACKOFF_CAP_MINUTES = 120;

interface BackoffState {
  failures: number;
  lastAttemptAt: number;
}

/** Minutes to wait after `failures` consecutive probes without an available section. */
export function quotaSamplerBackoffMinutes(failures: number): number {
  return failures <= 0
    ? 0
    : Math.min(BACKOFF_CAP_MINUTES, BACKOFF_BASE_MINUTES * 2 ** (failures - 1));
}

/** Logs non-interrupt causes and re-raises interrupts so scope closure still stops the loop. */
const isolate =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning(message, Cause.pretty(cause)),
      ),
    );

/**
 * Samples quota windows in the background so history survives without the
 * dashboard open. Instances are probed serially with the capability's
 * if-stale TTL; accounts that keep failing back off up to two hours.
 */
export function makeQuotaSampler(input: {
  readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
  /** Account keys that must keep their persisted rows (current and shadow accounts). */
  readonly listAccountKeys: Effect.Effect<ReadonlyArray<string>>;
  readonly permits: Semaphore.Semaphore;
  readonly recorder: AccountHistoryRecorder;
  readonly prune: (input: {
    readonly before: string;
    readonly keepAccountKeys: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}) {
  const backoff = new Map<string, BackoffState>();

  const sampleInstance = (instance: ProviderInstance) =>
    Effect.gen(function* () {
      const capability = instance.accountUsage;
      if (!instance.enabled || !capability?.refreshAccount) return;
      const account = yield* capability.getSnapshot;
      if (account.refreshState !== "idle") return;
      if (
        account.sections.length > 0 &&
        account.sections.every(
          (section) =>
            section.errorCode === "unsupported" || section.errorCode === "authentication-required",
        )
      )
        return;
      const now = yield* Clock.currentTimeMillis;
      const state = backoff.get(account.key);
      if (state && now - state.lastAttemptAt < quotaSamplerBackoffMinutes(state.failures) * 60_000)
        return;
      const result = yield* Effect.exit(
        capability
          .refreshAccount(input.permits, "if-stale")
          .pipe(Effect.timeout(QUOTA_SAMPLER_PROBE_TIMEOUT)),
      );
      if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
        return yield* Effect.failCause(result.cause);
      const succeeded =
        Exit.isSuccess(result) &&
        result.value.snapshot.sections.some((section) => section.outcome === "available");
      if (Exit.isSuccess(result))
        yield* input.recorder.observe(result.value.snapshot, capability.identity);
      backoff.set(
        account.key,
        succeeded
          ? { failures: 0, lastAttemptAt: now }
          : { failures: (state?.failures ?? 0) + 1, lastAttemptAt: now },
      );
      if (Exit.isFailure(result))
        yield* Effect.logWarning(
          "Background quota sample failed",
          account.key,
          Cause.pretty(result.cause),
        );
    });

  const tick = Effect.gen(function* () {
    const instances = yield* input.listInstances;
    for (const instance of instances)
      yield* sampleInstance(instance).pipe(isolate("Background quota sampling failed"));
    const now = yield* Clock.currentTimeMillis;
    const keepAccountKeys = yield* input.listAccountKeys;
    yield* input
      .prune({
        before: new Date(now - QUOTA_SAMPLE_RETENTION_MS).toISOString(),
        keepAccountKeys,
      })
      .pipe(isolate("Quota history pruning failed"));
  }).pipe(isolate("Background quota sampling tick failed"));

  const run = Effect.sleep(QUOTA_SAMPLER_INITIAL_DELAY).pipe(
    Effect.andThen(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(QUOTA_SAMPLER_INTERVAL))))),
  );

  return { tick, run };
}
