import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { expect, it } from "vitest";
import { createPersistentOrchestrationSystem } from "./testUtils/persistentOrchestration.ts";
import { reconcileCodexThreadSnapshots } from "./codexSnapshotReconciliation.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";

type CommandInput<C = OrchestrationCommand> = C extends OrchestrationCommand
  ? Omit<C, "commandId">
  : never;

it.each([
  "complete",
  "partial",
  "different-identity",
  "divergent",
  "tool",
  "reasoning",
  "replaced",
  "deleted",
] as const)(
  "verifies %s native history before reopening turn admission",
  async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-history-reconciliation-"));
    const system = await createPersistentOrchestrationSystem({
      dbPath: path.join(directory, "state.sqlite"),
    });
    const threadId = ThreadId.makeUnsafe("incomplete-thread"),
      turnId = TurnId.makeUnsafe("incomplete-turn");
    const messageId = MessageId.makeUnsafe("assistant:native-item"),
      projectId = ProjectId.makeUnsafe("project");
    const instanceId = ProviderInstanceId.make("codex");
    const createdAt = "2026-10-19T00:00:00.000Z";
    let command = 0;
    const dispatch = (input: CommandInput) =>
      system.run(
        system.engine.dispatch({
          ...input,
          commandId: CommandId.makeUnsafe(`reconcile-test:${++command}`),
        } as OrchestrationCommand),
      );
    let binding: ProviderRuntimeBindingWithMetadata = {
      threadId,
      provider: "codex",
      providerInstanceId: instanceId,
      lastSeenAt: createdAt,
      runtimePayload: {
        sessionGeneration: 1,
        historyReconciliationRequired: {
          eventId: "lost",
          turnId,
          historyIdentity: "native-thread",
        },
      },
    };
    let acknowledged = false;
    const snapshot: ProviderThreadSnapshot = {
      threadId,
      history: {
        identity: mode === "different-identity" ? "other-thread" : "native-thread",
        provenance: "provider-persisted",
        coverage: mode === "partial" ? "partial" : "complete",
        boundary: turnId,
        runtimeId: null,
        origin: { instanceId, generation: 1 },
      },
      turns: [
        {
          id: turnId,
          items: [
            {
              type: "agentMessage",
              id: "native-item",
              text: mode === "divergent" ? "different" : " prefix suffix\n ",
            },
            ...(mode === "tool"
              ? [{ type: "commandExecution", id: "cmd", command: "echo x" }]
              : mode === "reasoning"
                ? [{ type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] }]
                : []),
          ],
        },
      ],
    };
    try {
      await dispatch({
        type: "project.create",
        projectId,
        title: "Project",
        workspaceRoot: directory,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      await dispatch({
        type: "thread.create",
        threadId,
        projectId,
        title: "Thread",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await dispatch({
        type: "thread.turn.start",
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("user"),
          role: "user",
          text: "work",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
      const session = {
        threadId,
        providerName: "codex" as const,
        providerInstanceId: instanceId,
        runtimeMode: "full-access" as const,
        lastError: null,
        updatedAt: createdAt,
      };
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: { ...session, status: "running", activeTurnId: turnId },
        createdAt,
      });
      await dispatch({
        type: "thread.message.assistant.delta",
        threadId,
        messageId,
        turnId,
        delta: " prefix",
        createdAt,
      });
      await dispatch({
        type: "thread.message.assistant.complete",
        threadId,
        messageId,
        turnId,
        createdAt,
      });
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: "Incomplete output",
        },
        createdAt,
      });
      const head = (await system.run(system.engine.getReadModel())).snapshotSequence;
      const reconcile = () =>
        system.run(
          reconcileCodexThreadSnapshots(
            {
              orchestrationEngine: system.engine,
              providerSessionDirectory: { getBinding: () => Effect.succeed(Option.some(binding)) },
              providerService: {
                readThread: () =>
                  Effect.promise(async () => {
                    if (mode === "replaced")
                      binding = {
                        ...binding,
                        runtimePayload: {
                          ...(binding.runtimePayload as object),
                          sessionGeneration: 2,
                        },
                      };
                    if (mode === "deleted") await dispatch({ type: "thread.delete", threadId });
                    return snapshot;
                  }),
                acknowledgeHistoryReconciliation: (input) =>
                  Effect.sync(() => {
                    expect(input).toMatchObject({
                      markerId: "lost",
                      historyIdentity: "native-thread",
                      instanceId,
                      generation: 1,
                    });
                    acknowledged = true;
                    binding = { ...binding, runtimePayload: { sessionGeneration: 1 } };
                    return true;
                  }),
              },
            },
            { threadIds: [threadId], reason: "overload", mode: "complete-or-extend", createdAt },
          ),
        );
      await reconcile();
      const state = await system.run(system.engine.getReadModel());
      const message = state.threads[0]!.messages.find((message) => message.id === messageId)!;
      expect(acknowledged).toBe(mode === "complete");
      if (mode === "deleted") {
        expect(message).toBeUndefined();
        return;
      }
      expect(message.text).toBe(mode === "complete" ? " prefix suffix\n " : " prefix");
      expect(message.streaming).toBe(false);
      if (mode === "complete") {
        await reconcile();
        expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(
          state.snapshotSequence,
        );
      } else expect(state.snapshotSequence).toBe(head);
    } finally {
      await system.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
