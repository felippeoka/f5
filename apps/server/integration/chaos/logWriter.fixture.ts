/** Delays the final physical write so the parent can kill the real logging process mid-batch. */
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { makeEventNdjsonLogger } from "../../src/provider/Layers/EventNdjsonLogger.ts";

const directory = process.argv[2]!;
const originalOpen = fs.open;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  const write = handle.writeFile.bind(handle);
  handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
    const text = writeArgs[0];
    if (typeof text === "string" && text.includes('"eventId":"partial-completion"')) {
      await write(text.slice(0, -1), writeArgs[1]);
      process.stdout.write('F5_CHAOS:{"type":"partial"}\n');
      return await new Promise<never>(() => {});
    }
    return write(...writeArgs);
  };
  return handle;
};
await Effect.runPromise(
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-repair");
    const native = yield* makeEventNdjsonLogger(path.join(directory, "native.ndjson"), {
      stream: "native",
      batchWindowMs: 10_000,
    });
    const canonical = yield* makeEventNdjsonLogger(path.join(directory, "canonical.ndjson"), {
      stream: "canonical",
      batchWindowMs: 10_000,
    });
    if (!native || !canonical) throw new Error("Could not open fixture logs");
    yield* native.write(
      {
        event: {
          createdAt: "2026-10-07T09:38:00.000Z",
          method: "claude/assistant",
          payload: {
            session_id: "session",
            uuid: "target",
            message: {
              id: "message-target",
              role: "assistant",
              content: [{ type: "text", text: "recovered answer" }],
            },
          },
        },
      },
      threadId,
    );
    for (let index = 0; index < 8; index++)
      yield* canonical.write({ type: "content.delta", delta: String(index) }, null);
    yield* canonical.write(
      {
        type: "turn.completed",
        eventId: "partial-completion",
        provider: "codex",
        threadId,
        turnId: "turn-repair",
        createdAt: "2026-08-18T08:00:00.000Z",
        payload: { state: "completed" },
      },
      null,
    );
    throw new Error("Parent should kill the delayed write before it acknowledges completion");
  }),
);
