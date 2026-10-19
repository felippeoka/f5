import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_CHANNELS,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Ref, Stream } from "effect";
import { it, assert } from "@effect/vitest";
import {
  makeOrchestrationIntegrationHarness,
  seedOrchestrationProjectAndThread,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeServerPushBus } from "../../src/wsServer/pushBus.ts";
import { closeSocketsWithin } from "../../src/wsServer/socketLiveness.ts";
import { connectStoreClient } from "./client.ts";

it.live(
  "a WebSocket drop mid-stream converges the real client store without duplicate deltas",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* Effect.acquireRelease(
          makeOrchestrationIntegrationHarness(),
          (harness) => harness.dispose,
        );
        yield* seedOrchestrationProjectAndThread(harness);
        const clients = yield* Ref.make(new Set<WebSocket>());
        const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        const listening = once(server, "listening");
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await closeSocketsWithin(server.clients, performance.now() + 100);
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }),
        );
        const incarnation = randomUUID();
        server.on("connection", (socket) => {
          Effect.runSync(Ref.update(clients, (previous) => new Set([...previous, socket])));
          socket.on("close", () =>
            Effect.runSync(
              Ref.update(
                clients,
                (previous) => new Set([...previous].filter((client) => client !== socket)),
              ),
            ),
          );
          socket.on("message", (bytes) => {
            const request = JSON.parse(String(bytes));
            if (request.method === "snapshot")
              void Effect.runPromise(harness.engine.getReadModel()).then((snapshot) =>
                socket.send(JSON.stringify({ id: request.id, snapshot })),
              );
          });
          socket.send(JSON.stringify({ type: "welcome", incarnation }));
        });
        yield* Effect.promise(() => listening);
        const address = server.address();
        if (typeof address === "string" || address === null)
          throw new Error("Expected an ephemeral TCP address");
        const push = yield* makeServerPushBus({ clients, logOutgoingPush: () => {} });
        yield* Stream.runForEach(harness.engine.streamDomainEvents, (event) =>
          push.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
        ).pipe(Effect.forkScoped);
        const client = yield* Effect.acquireRelease(
          Effect.promise(() => connectStoreClient(`ws://127.0.0.1:${address.port}`)),
          (client) => Effect.promise(() => client.close()),
        );
        yield* Effect.promise(() => client.next("ready"));
        const barrier = Promise.withResolvers<void>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const createdAt = new Date().toISOString();
        const base = {
          provider: "codex" as const,
          threadId,
          turnId: "fixture-turn",
          itemId: "chaos-item",
          createdAt,
        };
        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          beforeEvent: (index) =>
            index === 2 ? Effect.promise(() => barrier.promise) : Effect.void,
          events: [
            { ...base, type: "turn.started", eventId: EventId.makeUnsafe("chaos-start") },
            {
              ...base,
              type: "content.delta",
              eventId: EventId.makeUnsafe("chaos-prefix"),
              payload: { streamKind: "assistant_text", delta: "prefix " },
            },
            {
              ...base,
              type: "content.delta",
              eventId: EventId.makeUnsafe("chaos-suffix"),
              payload: { streamKind: "assistant_text", delta: "suffix\n" },
            },
            {
              ...base,
              type: "item.completed",
              eventId: EventId.makeUnsafe("chaos-complete"),
              payload: { itemType: "assistant_message", status: "completed" },
            },
            {
              ...base,
              type: "turn.completed",
              eventId: EventId.makeUnsafe("chaos-terminal"),
              payload: { state: "completed" },
            },
          ],
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => barrier.resolve()));
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("chaos-dispatch"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("chaos-user"),
            role: "user",
            text: "stream",
            attachments: [],
          },
          assistantDeliveryMode: "streaming",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt,
        });
        yield* harness.waitForThread(threadId, (thread) =>
          thread.messages.some((message) => message.text === "prefix "),
        );
        client.send("disconnect");
        yield* Effect.promise(() => client.next("closed"));
        barrier.resolve();
        yield* harness.waitForThread(threadId, (thread) =>
          thread.messages.some(
            (message) => message.text === "prefix suffix\n" && !message.streaming,
          ),
        );
        client.send("reconnect");
        yield* Effect.promise(() => client.next("ready"));
        client.send("inspect");
        const observed = yield* Effect.promise(() => client.next("state"));
        const expected = (yield* harness.engine.getReadModel()).threads.map((thread) => ({
          id: thread.id,
          messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
        }));
        assert.deepEqual(observed.threads, expected);
      }),
    ),
  30_000,
);
