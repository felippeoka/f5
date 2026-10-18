import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CursorSettings,
  GrokSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config";
import { writeAcpWrapper } from "../../testUtils/cli";
import { makeCursorAdapter } from "../Layers/CursorAdapter";
import { makeGrokAdapter } from "../Layers/GrokAdapter";

it.each(["cursor", "grok", "antigravity"] as const)(
  "redacts %s update-only and derived task events with native logging disabled",
  async (provider) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-adapter-privacy-"));
    const executable = writeAcpWrapper(
      path.join(cwd, "agent"),
      path.resolve("scripts/acp-mock-agent.ts"),
      { env: { ACP_MOCK_PRIVATE_TOOL_EVENTS: "1" } },
    );
    const events: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter =
            provider === "cursor"
              ? yield* makeCursorAdapter(
                  Schema.decodeUnknownSync(CursorSettings)({ binaryPath: executable }),
                )
              : yield* makeGrokAdapter(
                  Schema.decodeUnknownSync(GrokSettings)({ binaryPath: executable }),
                  { provider },
                );
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe(`privacy-${provider}`);
          yield* adapter.startSession({
            threadId,
            provider,
            cwd,
            runtimeMode: "full-access",
            resumeCursor: { computerCapable: true },
          });
          yield* adapter.sendTurn({ threadId, input: "run fixture", attachments: [] });
          // sendTurn completes only after its event barrier has drained notifications.
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(cwd, path.join(cwd, "state"), { mode: "desktop" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
    expect(
      events.some(
        (event) => event.type === "item.completed" && event.itemId === "private-update-only",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type.startsWith("task."))).toBe(false);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_ADAPTER_SENTINEL");
  },
);
