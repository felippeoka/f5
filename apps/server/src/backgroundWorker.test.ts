import { Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";
import { enqueueBackgroundWork, makeBackgroundWorker } from "./backgroundWorker.ts";

it.each(["closed", "failed"])(
  "settles a detached flush timer after worker %s without a rejected Promise",
  async (phase) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* makeBackgroundWorker(
              (_item: number) => (phase === "failed" ? Effect.die("worker died") : Effect.void),
              { name: "flush-admission" },
            );
            if (phase === "closed") yield* worker.close;
            else {
              yield* worker.enqueue(0);
              expect(Exit.isFailure(yield* Effect.exit(worker.drain))).toBe(true);
            }
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) =>
                  setTimeout(() => {
                    enqueueBackgroundWork(worker.enqueue(1));
                    setImmediate(resolve);
                  }, 0),
                ),
            );
            expect(unhandled).not.toHaveBeenCalled();
          }),
        ),
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  },
);
