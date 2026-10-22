import { Effect, Logger } from "effect";
import { expect, it } from "vitest";
import { READ_MODEL_MESSAGE_WARNING_THRESHOLD } from "@t3tools/shared/orchestrationRetention";
import { observeReadModelRetention } from "./readModelRetention.ts";

it("warns above the message threshold without truncating or replacing retained history", async () => {
  const messages = Array.from({ length: READ_MODEL_MESSAGE_WARNING_THRESHOLD + 1 }, () => ({
    text: "answer",
    reasoningText: "reason",
  }));
  const original = [...messages];
  const logs: Array<{ level: string; message: unknown }> = [];
  const logger = Logger.make((entry) => {
    logs.push({ level: entry.logLevel, message: entry.message });
  });
  await Effect.runPromise(
    observeReadModelRetention({ threads: [{ messages }] }).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
  expect(logs).toEqual([
    {
      level: "Warn",
      message: [
        "orchestration read model exceeds message warning threshold",
        { threads: 1, messages: 200001, characters: 2400012 },
      ],
    },
  ]);
  expect(messages).toEqual(original);
});
