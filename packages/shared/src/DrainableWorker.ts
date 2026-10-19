import { Cause, Data, Deferred, Effect, Exit } from "effect";
import type { Scope } from "effect";

export class WorkerAdmissionError extends Data.TaggedError("WorkerAdmissionError")<{
  readonly worker: string;
  readonly reason: "closed" | "failed" | "full" | "too_large";
  readonly cause?: unknown;
}> {
  override get message() {
    return `Worker ${this.worker} cannot accept/finish work (${this.reason}).`;
  }
}
export interface WorkerSnapshot {
  readonly name: string;
  readonly phase: "accepting" | "draining" | "failed" | "closed";
  readonly entries: number;
  readonly bytes: number;
  readonly oldestAgeMs: number;
  readonly failures: number;
}
const liveWorkers = new Set<() => WorkerSnapshot>();
export const getDrainableWorkerSnapshots = (): ReadonlyArray<WorkerSnapshot> =>
  [...liveWorkers].map((read) => read());

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void, WorkerAdmissionError>;
  /** Nonblocking admission; false means full. Closed/failed workers reject explicitly. */
  readonly offer: (item: A) => Effect.Effect<boolean, WorkerAdmissionError>;
  readonly drain: Effect.Effect<void, WorkerAdmissionError>;
  readonly close: Effect.Effect<void, WorkerAdmissionError>;
  readonly snapshot: Effect.Effect<WorkerSnapshot>;
}
export interface DrainableWorkerOptions<A> {
  readonly name?: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly sizeOf?: (item: A) => number;
  readonly key?: (item: A) => string;
  readonly revision?: (item: A) => number;
  readonly admission?: "block" | "reject";
}

/** Accepted entries remain accounted until processing finishes, including failures. */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options: DrainableWorkerOptions<A> = {},
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    type Entry = { item: A; bytes: number; admittedAt: number; key: string | undefined };
    const name = options.name ?? "background";
    const queue: Entry[] = [];
    const queuedByKey = new Map<string, Entry>();
    let phase: WorkerSnapshot["phase"] = "accepting";
    let outstanding = 0,
      bytes = 0,
      failures = 0;
    let active: Entry | undefined;
    let failed: WorkerAdmissionError | undefined;
    let idle = yield* Deferred.make<void, WorkerAdmissionError>();
    yield* Deferred.succeed(idle, undefined);
    let changed = yield* Deferred.make<void>();
    const notify = Effect.gen(function* () {
      const previous = changed;
      changed = yield* Deferred.make<void>();
      yield* Deferred.succeed(previous, undefined);
    });
    const read = (): WorkerSnapshot => ({
      name,
      phase,
      entries: outstanding,
      bytes,
      oldestAgeMs: Math.max(
        0,
        Date.now() - (active?.admittedAt ?? queue[0]?.admittedAt ?? Date.now()),
      ),
      failures,
    });
    liveWorkers.add(read);
    yield* Effect.addFinalizer(() => Effect.sync(() => liveWorkers.delete(read)));
    const unavailable = () =>
      failed ?? new WorkerAdmissionError({ worker: name, reason: "closed" });
    const fail = (cause: unknown) =>
      Effect.gen(function* () {
        if (phase === "failed" || phase === "closed") return;
        failures++;
        failed = new WorkerAdmissionError({ worker: name, reason: "failed", cause });
        phase = "failed";
        queue.length = 0;
        queuedByKey.clear();
        active = undefined;
        outstanding = bytes = 0;
        yield* Deferred.fail(idle, failed);
        yield* notify;
        yield* Effect.logError("background worker failed", { worker: name, cause });
      });
    const admit = (item: A, block: boolean): Effect.Effect<boolean, WorkerAdmissionError> =>
      Effect.gen(function* () {
        const size = Math.max(0, Math.ceil(options.sizeOf?.(item) ?? 1));
        if (!Number.isFinite(size) || size > (options.maxBytes ?? Infinity))
          return yield* new WorkerAdmissionError({ worker: name, reason: "too_large" });
        const key = options.key?.(item);
        for (;;) {
          const result = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (phase !== "accepting") return yield* unavailable();
              const previous = key === undefined ? undefined : queuedByKey.get(key);
              if (
                previous &&
                options.revision &&
                options.revision(previous.item) > options.revision(item)
              )
                return true;
              const extraBytes = size - (previous?.bytes ?? 0);
              if (
                bytes + extraBytes > (options.maxBytes ?? Infinity) ||
                (!previous && outstanding >= (options.maxEntries ?? Infinity))
              )
                return changed;
              if (previous) {
                previous.item = item;
                previous.bytes = size;
                bytes += extraBytes;
              } else {
                if (outstanding === 0) idle = yield* Deferred.make<void, WorkerAdmissionError>();
                const entry = { item, bytes: size, admittedAt: Date.now(), key };
                outstanding++;
                bytes += size;
                queue.push(entry);
                if (key !== undefined) queuedByKey.set(key, entry);
              }
              yield* notify;
              return true;
            }),
          );
          if (result === true) return true;
          if (!block) return false;
          if (options.admission === "reject")
            return yield* new WorkerAdmissionError({ worker: name, reason: "full" });
          // Admission accounting happens only after capacity is acquired. Interrupting
          // this wait cannot leave an accepted-but-never-enqueued item behind.
          yield* Deferred.await(result);
        }
      });
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          const entry = queue.shift();
          if (!entry) {
            if (phase === "draining" || phase === "closed" || phase === "failed") return;
            yield* Deferred.await(changed);
            continue;
          }
          if (entry.key !== undefined) queuedByKey.delete(entry.key);
          active = entry;
          yield* process(entry.item);
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              active = undefined;
              outstanding--;
              bytes -= entry.bytes;
              if (outstanding === 0) yield* Deferred.succeed(idle, undefined);
              yield* notify;
            }),
          );
        }
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && outstanding > 0
            ? fail(Cause.squash(exit.cause))
            : Effect.sync(() => {
                if (phase !== "failed") phase = "closed";
              }),
        ),
      ),
    );
    const drain = Effect.suspend(() => (failed ? Effect.fail(failed) : Deferred.await(idle)));
    const close = Effect.gen(function* () {
      if (phase === "accepting") {
        phase = "draining";
        yield* notify;
      }
      yield* drain;
      phase = "closed";
      yield* notify;
    });
    return {
      enqueue: (item) => admit(item, true).pipe(Effect.asVoid),
      offer: (item) => admit(item, false),
      drain,
      close,
      snapshot: Effect.sync(read),
    } satisfies DrainableWorker<A>;
  });
