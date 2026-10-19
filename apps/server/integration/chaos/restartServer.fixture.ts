/** A separate, killable server process. The parent owns its database and provider receipt file. */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import {
  makeOrchestrationIntegrationHarness,
  seedOrchestrationProjectAndThread,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeClientTransport } from "./transport.ts";

const [rootDir, boundary] = process.argv.slice(2);
if (!rootDir || !boundary) throw new Error("Missing crash fixture arguments");
const report = (value: unknown) => process.stdout.write(`F5_CHAOS:${JSON.stringify(value)}\n`);
const threadId = ThreadId.makeUnsafe("thread-1");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* Effect.acquireRelease(
        makeOrchestrationIntegrationHarness({
          rootDir,
          startReactors: boundary !== "before-send",
          prepareAdapter: (adapter) =>
            adapter.queueTurnResponseForNextSession({
              beforeEvent: (index) =>
                index !== 0
                  ? Effect.void
                  : Effect.sync(() => {
                      appendFileSync(
                        path.join(rootDir, "provider-acceptances.ndjson"),
                        `${JSON.stringify({ accepted: true })}\n`,
                      );
                      report({ type: "accepted" });
                    }).pipe(
                      Effect.andThen(boundary === "after-acceptance" ? Effect.never : Effect.void),
                    ),
              events: [
                {
                  type: "turn.started",
                  eventId: EventId.makeUnsafe("start"),
                  provider: "codex",
                  threadId,
                  turnId: "turn",
                  createdAt: new Date().toISOString(),
                },
                {
                  type: "content.delta",
                  eventId: EventId.makeUnsafe("delta"),
                  provider: "codex",
                  threadId,
                  turnId: "turn",
                  itemId: "crash-answer",
                  createdAt: new Date().toISOString(),
                  payload: { streamKind: "assistant_text", delta: "exact answer\n" },
                },
                {
                  type: "item.completed",
                  eventId: EventId.makeUnsafe("item"),
                  provider: "codex",
                  threadId,
                  turnId: "turn",
                  itemId: "crash-answer",
                  createdAt: new Date().toISOString(),
                  payload: { itemType: "assistant_message", status: "completed" },
                },
                {
                  type: "turn.completed",
                  eventId: EventId.makeUnsafe("done"),
                  provider: "codex",
                  threadId,
                  turnId: "turn",
                  createdAt: new Date().toISOString(),
                  payload: { state: "completed" },
                },
              ],
            }),
        }),
        (harness) => harness.dispose,
      );
      const transport = yield* makeClientTransport(harness);
      const commands = createInterface({ input: process.stdin });
      yield* Effect.addFinalizer(() => Effect.sync(() => commands.close()));
      commands.on("line", (line) => {
        const { method } = JSON.parse(line);
        const operation =
          method === "seed"
            ? seedOrchestrationProjectAndThread(harness)
            : method === "dispatch"
              ? harness.engine.dispatch({
                  type: "thread.turn.start",
                  commandId: CommandId.makeUnsafe("crash-turn"),
                  threadId,
                  message: {
                    messageId: MessageId.makeUnsafe("crash-user"),
                    role: "user",
                    text: "work",
                    attachments: [],
                  },
                  assistantDeliveryMode: "streaming",
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  createdAt: new Date().toISOString(),
                })
              : method === "settled"
                ? harness.waitForThread(threadId, (thread) =>
                    thread.messages.some(
                      (message) => message.text === "exact answer\n" && !message.streaming,
                    ),
                  )
                : method === "state"
                  ? harness.engine.getReadModel()
                  : Effect.fail(new Error(`Unknown command ${method}`));
        void Effect.runPromise(operation).then(
          (value) => report({ type: method, value }),
          (error) => report({ type: "failure", message: String(error) }),
        );
      });
      report({ type: "ready", url: transport.url, dbPath: harness.dbPath });
      return yield* Effect.never;
    }),
  ),
);
