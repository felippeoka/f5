import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { makeCommandAdmission } from "./commandAdmission.ts";

it.effect("reserves control admission under saturation and retains it until completion", () =>
  Effect.gen(function* () {
    const queue = yield* makeCommandAdmission<string>({
      ordinaryEntries: 2,
      ordinaryBytes: 10,
      controlEntries: 1,
    });
    yield* queue.offer("active", 5, false);
    assert.equal(yield* queue.take, "active");
    yield* queue.offer("bulk", 5, false);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("overflow", 1, false))));
    yield* queue.offer("stop", 1, true);
    assert.equal(yield* queue.take, "stop");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("second-stop", 1, true))));
    yield* queue.release("stop");
    yield* queue.offer("approval", 1, true);
    assert.equal(yield* queue.take, "approval");
    yield* queue.release("approval");
    yield* queue.release("active");
    assert.equal(yield* queue.take, "bulk");
    yield* queue.release("bulk");
    assert.equal(queue.snapshot().entries, 0);
  }),
);
it.effect("cancels only queued starts and closes an idle consumer without leaking a waiter", () =>
  Effect.gen(function* () {
    const queue = yield* makeCommandAdmission<string>();
    yield* queue.offer("active-start", 1, false);
    yield* queue.take;
    yield* queue.offer("old-start", 1, false);
    yield* queue.offer("other-thread", 1, false);
    assert.deepEqual(yield* queue.cancelQueued((item) => item.endsWith("start")), ["old-start"]);
    assert.equal(yield* queue.take, "other-thread");
    yield* queue.release("active-start");
    yield* queue.release("other-thread");
    const waiter = yield* queue.take.pipe(Effect.forkChild);
    yield* queue.close;
    assert.isUndefined(yield* Fiber.join(waiter));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("late", 1, true))));
  }),
);
