import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Crypto from "node:crypto";
import { Deferred, Effect, Exit, Schema, Scope, SynchronizedRef } from "effect";
import { StorageUsageReport, type StorageScanStatus } from "@t3tools/contracts";
import { userFacingCauseMessage } from "../causeMessage.ts";

export interface UsageScanState {
  readonly generation: number;
  readonly latest: { readonly report: StorageUsageReport; readonly generation: number } | null;
  readonly running: Deferred.Deferred<void> | null;
  readonly lastFailure: number | null;
  readonly revision: number;
  readonly scan: StorageScanStatus;
}
const idle: StorageScanStatus = {
  state: "idle",
  phase: null,
  entriesVisited: 0,
  startedAt: null,
  error: null,
};
export const makeUsageScanCoordinator = <E>(input: {
  readonly stateDir: string;
  readonly scan: (
    signal: AbortSignal,
    progress: (phase: NonNullable<StorageScanStatus["phase"]>, entries?: number) => void,
  ) => Effect.Effect<StorageUsageReport, E>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const persistedPath = Path.join(input.stateDir, "storage-usage.json");
    const persisted = yield* Effect.tryPromise(async () => {
      try {
        return Schema.decodeUnknownSync(StorageUsageReport)(
          JSON.parse(await FS.readFile(persistedPath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load saved storage measurement", error).pipe(Effect.as(null)),
      ),
    );
    const ref = yield* SynchronizedRef.make<UsageScanState>({
      generation: 0,
      latest: persisted ? { report: persisted, generation: -1 } : null,
      running: null,
      lastFailure: null,
      revision: 0,
      scan: idle,
    });
    const snapshot = SynchronizedRef.get(ref);
    const noteMutated = SynchronizedRef.update(ref, (state) => ({
      ...state,
      generation: state.generation + 1,
      revision: state.revision + 1,
    }));
    const request = (force = false) =>
      SynchronizedRef.modifyEffect(ref, (state) =>
        Effect.gen(function* () {
          if (
            state.running ||
            (!force && state.lastFailure !== null && Date.now() - state.lastFailure < 60_000)
          )
            return [undefined, state] as const;
          const done = yield* Deferred.make<void>();
          const run = Effect.gen(function* () {
            for (let attempt = 0; attempt < 3; attempt++) {
              const start = yield* snapshot;
              const controller = new AbortController();
              const progress = (phase: NonNullable<StorageScanStatus["phase"]>, entries = 0) => {
                Effect.runFork(
                  SynchronizedRef.update(ref, (current) =>
                    current.running === done &&
                    current.scan.state === "scanning" &&
                    !controller.signal.aborted
                      ? {
                          ...current,
                          revision: current.revision + 1,
                          scan: { ...current.scan, phase, entriesVisited: entries },
                        }
                      : current,
                  ),
                );
              };
              const result = yield* Effect.exit(
                input
                  .scan(controller.signal, progress)
                  .pipe(Effect.ensuring(Effect.sync(() => controller.abort()))),
              );
              if (Exit.isFailure(result)) {
                yield* Effect.logWarning("Storage scan failed", result.cause);
                yield* SynchronizedRef.update(ref, (current) => ({
                  ...current,
                  running: null,
                  lastFailure: Date.now(),
                  revision: current.revision + 1,
                  scan: {
                    ...current.scan,
                    state: "failed" as const,
                    phase: null,
                    error: userFacingCauseMessage(result.cause, "Storage scan failed.", {
                      maxLength: 300,
                    }),
                  },
                }));
                break;
              }
              const published = yield* SynchronizedRef.modify(ref, (current) => {
                if (start.generation !== current.generation && attempt < 2)
                  return [false, current] as const;
                return [
                  true,
                  {
                    ...current,
                    latest: { report: result.value, generation: start.generation },
                    running: null,
                    lastFailure: null,
                    revision: current.revision + 1,
                    scan: { ...current.scan, state: "idle" as const, phase: null },
                  },
                ] as const;
              }).pipe(Effect.uninterruptible);
              if (!published) continue;
              yield* Effect.tryPromise(async () => {
                const temporary = `${persistedPath}.${Crypto.randomUUID()}.tmp`;
                try {
                  await FS.writeFile(
                    temporary,
                    JSON.stringify({
                      ...result.value,
                      categories: result.value.categories.map((category) => ({
                        ...category,
                        targets: category.targets
                          .toSorted((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))
                          .slice(0, 500),
                      })),
                    }),
                  );
                  await FS.rename(temporary, persistedPath);
                } finally {
                  await FS.unlink(temporary).catch(() => {});
                }
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not persist storage measurement", error),
                ),
              );
              break;
            }
          }).pipe(
            Effect.ensuring(Deferred.succeed(done, undefined)),
            Effect.ensuring(
              SynchronizedRef.update(ref, (current) =>
                current.running === done ? { ...current, running: null } : current,
              ),
            ),
          );
          yield* run.pipe(Effect.forkIn(scope));
          return [
            undefined,
            {
              ...state,
              running: done,
              revision: state.revision + 1,
              scan: {
                ...idle,
                state: "scanning" as const,
                phase: "database" as const,
                startedAt: new Date().toISOString(),
              },
            },
          ] as const;
        }),
      );
    const awaitLatest = Effect.gen(function* () {
      const state = yield* snapshot;
      if (state.running) yield* Deferred.await(state.running);
      return (yield* snapshot).latest;
    });
    return { snapshot, request, awaitLatest, noteMutated };
  });
