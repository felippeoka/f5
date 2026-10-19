import { Deferred, Effect } from "effect";
import type { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";
import { OrchestrationOverloadError } from "./Errors.ts";

export const isControlCommand = (command: Pick<OrchestrationCommand, "type">) =>
  command.type === "thread.session.stop" ||
  command.type === "thread.turn.interrupt" ||
  command.type === "thread.approval.respond" ||
  command.type === "thread.user-input.respond";
export const isControlEvent = (event: Pick<OrchestrationEvent, "type">) =>
  event.type === "thread.session-stop-requested" ||
  event.type === "thread.turn-interrupt-requested" ||
  event.type === "thread.approval-response-requested" ||
  event.type === "thread.user-input-response-requested";

/** Controls retain their reservation until the reactor records their outcome. */
export const makeCommandAdmission = <A>(
  options: {
    ordinaryEntries?: number;
    ordinaryBytes?: number;
    controlEntries?: number;
  } = {},
) =>
  Effect.gen(function* () {
    type Entry = { item: A; bytes: number; control: boolean; admittedAt: number };
    const ordinary: Entry[] = [],
      controls: Entry[] = [];
    const accepted = new Map<A, Entry>();
    let ordinaryEntries = 0,
      ordinaryBytes = 0,
      controlEntries = 0,
      closed = false;
    let changed = yield* Deferred.make<void>();
    const notify = Effect.gen(function* () {
      const previous = changed;
      changed = yield* Deferred.make<void>();
      yield* Deferred.succeed(previous, undefined);
    });
    const release = (item: A) =>
      Effect.gen(function* () {
        const entry = accepted.get(item);
        if (!entry) return;
        accepted.delete(item);
        if (entry.control) controlEntries--;
        else {
          ordinaryEntries--;
          ordinaryBytes -= entry.bytes;
        }
        yield* notify;
      });
    return {
      offer: (item: A, bytes: number, control: boolean) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (
              closed ||
              !Number.isFinite(bytes) ||
              bytes < 0 ||
              (control
                ? controlEntries >= (options.controlEntries ?? 64)
                : ordinaryEntries >= (options.ordinaryEntries ?? 1024) ||
                  ordinaryBytes + bytes > (options.ordinaryBytes ?? 32 * 1024 * 1024))
            )
              return yield* new OrchestrationOverloadError({
                lane: control ? "control" : "ordinary",
                reason: closed ? "closed" : "full",
              });
            const entry = { item, bytes, control, admittedAt: Date.now() };
            accepted.set(item, entry);
            if (control) {
              controlEntries++;
              controls.push(entry);
            } else {
              ordinaryEntries++;
              ordinaryBytes += bytes;
              ordinary.push(entry);
            }
            yield* notify;
          }),
        ),
      take: Effect.suspend(function take(): Effect.Effect<A | undefined> {
        const entry = controls.shift() ?? ordinary.shift();
        if (entry) return Effect.succeed(entry.item);
        if (closed) return Effect.succeed(undefined);
        return Deferred.await(changed).pipe(Effect.andThen(Effect.suspend(take)));
      }),
      release,
      cancelQueued: (predicate: (item: A) => boolean) =>
        Effect.gen(function* () {
          const cancelled: A[] = [];
          for (let index = ordinary.length - 1; index >= 0; index--) {
            const entry = ordinary[index]!;
            if (!predicate(entry.item)) continue;
            ordinary.splice(index, 1);
            cancelled.push(entry.item);
            yield* release(entry.item);
          }
          return cancelled;
        }),
      close: Effect.gen(function* () {
        closed = true;
        yield* notify;
      }),
      snapshot: () => ({
        entries: accepted.size,
        bytes: [...accepted.values()].reduce((sum, entry) => sum + entry.bytes, 0),
        oldestAgeMs: Math.max(
          0,
          ...[...accepted.values()].map((entry) => Date.now() - entry.admittedAt),
        ),
      }),
      pending: () => [...accepted.keys()],
    };
  });
