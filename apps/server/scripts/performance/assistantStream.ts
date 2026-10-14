/**
 * Streaming assistant workload through the production ingestion path:
 * ProviderRuntimeIngestion -> OrchestrationEngine.dispatch -> ProjectionPipeline,
 * against a disposable on-disk SQLite database.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { ServerConfig } from "../../src/config.ts";
import { OrchestrationEngineLive } from "../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ThreadBackgroundWorkLive } from "../../src/orchestration/Layers/ThreadBackgroundWork.ts";
import { ThreadCommandExecutionQueryLive } from "../../src/orchestration/Layers/ThreadCommandExecutionQuery.ts";
import { ThreadFileChangeQueryLive } from "../../src/orchestration/Layers/ThreadFileChangeQuery.ts";
import { OrchestrationEngineService } from "../../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../../src/persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadFileChangeRepositoryLive } from "../../src/persistence/Layers/ProjectionThreadFileChanges.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../../src/persistence/Layers/Sqlite.ts";
import { UsageFactRepositoryLive } from "../../src/persistence/Layers/UsageFacts.ts";
import { ProjectionThreadMessageRepository } from "../../src/persistence/Services/ProjectionThreadMessages.ts";
import { ProviderSessionDirectoryLive } from "../../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../src/provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../src/provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../src/serverSettings.ts";
import {
  assistantStreamDelta,
  fixture,
  messageFixture,
} from "../../../../scripts/lib/performance/fixtures.ts";
import {
  maximumObservation,
  measure,
  type Observation,
  type Samples,
} from "../../../../scripts/lib/performance/report.ts";

const workload = fixture.assistantStream;
const epochMs = Date.parse(fixture.epoch);
const at = (offsetMs: number) => new Date(epochMs + offsetMs).toISOString();
const projectId = ProjectId.makeUnsafe("perf-stream-project");
const streamThreadId = (stream: number) => ThreadId.makeUnsafe(`perf-stream-${stream}`);

/** Only the calls ingestion makes; anything else is a harness bug. */
function makeProviderService() {
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const sessions: ProviderSession[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in perf")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    respondToElicitation: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...sessions]),
    getSessionCapabilities: () => Effect.succeed(null),
    assertSessionAction: () => unsupported(),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackConversation: () => unsupported(),
    runOneOffPrompt: () => unsupported(),
    compactConversation: () => unsupported(),
    reloadMcpConfigForProject: () => unsupported(),
    streamEvents: Stream.fromPubSub(events),
  };
  return {
    service,
    sessions,
    emit: (event: Record<string, unknown>) =>
      Effect.runSync(PubSub.publish(events, event as unknown as ProviderRuntimeEvent)),
  };
}

function makeLayer(directory: string, database: string, provider: ProviderServiceShape) {
  const sessionDirectory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const engine = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  return ProviderRuntimeIngestionLive.pipe(
    Layer.provide(ServerSettingsService.layerTest({ enableAssistantStreaming: true })),
    Layer.provideMerge(engine),
    Layer.provideMerge(
      ThreadCommandExecutionQueryLive.pipe(
        Layer.provideMerge(ProjectionThreadCommandExecutionRepositoryLive),
      ),
    ),
    Layer.provideMerge(
      ThreadFileChangeQueryLive.pipe(Layer.provideMerge(ProjectionThreadFileChangeRepositoryLive)),
    ),
    Layer.provideMerge(sessionDirectory),
    Layer.provideMerge(ThreadBackgroundWorkLive.pipe(Layer.provideMerge(sessionDirectory))),
    Layer.provideMerge(UsageFactRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(database)),
    Layer.provideMerge(Layer.succeed(ProviderService, provider)),
    Layer.provideMerge(ServerConfig.layerTest(directory, path.join(directory, "state"))),
    Layer.provideMerge(NodeServices.layer),
  );
}

/** Creates threads by dispatch, then seeds projected history through the repository. */
async function seed(
  directory: string,
  database: string,
  threadIds: ReadonlyArray<ThreadId>,
  messagesPerThread: number,
) {
  const runtime = ManagedRuntime.make(
    makeLayer(directory, database, makeProviderService().service),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const messages = yield* ProjectionThreadMessageRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("perf-stream-project-create"),
          projectId,
          title: "Perf stream project",
          workspaceRoot: directory,
          defaultModel: "gpt-5-codex",
          createdAt: at(0),
        });
        for (const threadId of threadIds)
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`${threadId}-create`),
            threadId,
            projectId,
            title: threadId,
            model: "gpt-5-codex",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at(0),
          });
        for (const threadId of threadIds)
          yield* sql.withTransaction(
            Effect.forEach(
              Array.from({ length: messagesPerThread }, (_, index) => messageFixture(index)),
              (message) =>
                messages.upsert({
                  messageId: MessageId.makeUnsafe(`${threadId}:${message.id}`),
                  threadId,
                  turnId: null,
                  role: message.role,
                  text: message.text,
                  isStreaming: false,
                  createdAt: message.createdAt,
                  updatedAt: message.createdAt,
                }),
              { discard: true },
            ),
          );
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

export async function measureAssistantStream(
  method: typeof fixture.method,
): Promise<{ samples: Samples; observations: Observation[] }> {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-performance-stream-"));
  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as StatementSync;
  probe.close();
  const counts = { statements: 0, projectionStatements: 0, eventRows: 0, domainEvents: 0 };
  const count = (statement: StatementSync) => {
    counts.statements++;
    if (statement.sourceSQL.includes("projection_")) counts.projectionStatements++;
    if (/INSERT\s+INTO\s+orchestration_events\b/i.test(statement.sourceSQL)) counts.eventRows++;
  };
  // A plain patch rather than vi.spyOn: spies retain every call's result rows.
  const originalAll = statementPrototype.all;
  const originalRun = statementPrototype.run;
  statementPrototype.all = function (this: StatementSync, ...params: unknown[]) {
    count(this);
    return Reflect.apply(originalAll, this, params);
  } as typeof originalAll;
  statementPrototype.run = function (this: StatementSync, ...params: unknown[]) {
    count(this);
    return Reflect.apply(originalRun, this, params);
  } as typeof originalRun;
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  try {
    const threadIds = Array.from({ length: workload.threads }, (_, i) => streamThreadId(i));
    const database = path.join(directory, "stream.sqlite");
    await seed(directory, database, threadIds, workload.seededMessages);

    const provider = makeProviderService();
    const runtime = ManagedRuntime.make(makeLayer(directory, database, provider.service));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
      const sessions = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
      const hydrated = await runtime.runPromise(engine.getReadModel());
      for (const threadId of threadIds)
        expect(hydrated.threads.find((thread) => thread.id === threadId)?.messages.length).toBe(
          workload.seededMessages,
        );

      const waiters = new Map<string, () => void>();
      runtime.runFork(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          Effect.sync(() => {
            counts.domainEvents++;
            const resolve = event.commandId === null ? undefined : waiters.get(event.commandId);
            if (resolve) {
              waiters.delete(event.commandId!);
              resolve();
            }
          }),
        ),
      );
      await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const threadId of threadIds) {
        provider.sessions.push({
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: at(0),
          updatedAt: at(0),
        });
        await runtime.runPromise(
          sessions.upsert({
            threadId,
            provider: "codex",
            status: "running",
            runtimeMode: "full-access",
            runtimePayload: { activeTurnId: null },
          }),
        );
        // The turn request selects streaming delivery, so every delta is dispatched.
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`${threadId}-turn-request`),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(`${threadId}-request`),
              role: "user",
              text: "Stream a long answer",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            assistantDeliveryMode: "streaming",
            createdAt: at(1),
          }),
        );
      }
      await runtime.runPromise(ingestion.drain);

      let repetition = 0;
      const latencies: number[][] = [];
      const perRepetition: Array<typeof counts> = [];
      const runStream = async (stream: number, rep: number) => {
        const threadId = streamThreadId(stream);
        const turnId = `perf-turn-${rep}`;
        const itemId = `perf-item-${stream}-${rep}`;
        const base = { provider: "codex", threadId, turnId };
        const createdAt = at(86_400_000 + rep * 1000);
        const id = (suffix: string) => `perf-${rep}-${stream}-${suffix}`;
        provider.emit({ ...base, type: "turn.started", eventId: id("turn-started"), createdAt });
        for (let index = 0; index < workload.deltasPerStream; index++) {
          if (stream === 0 && index > 0 && index % workload.toolEvery === 0) {
            for (const [itemType, title] of [
              ["command_execution", "bun test"],
              ["dynamic_tool_call", "Read file"],
            ] as const) {
              const toolItem = `${itemType}-${rep}-${index}`;
              provider.emit({
                ...base,
                type: "item.started",
                eventId: id(`${toolItem}-started`),
                itemId: toolItem,
                createdAt,
                payload: { itemType, status: "in_progress", title, detail: "src/index.ts" },
              });
              provider.emit({
                ...base,
                type: "item.completed",
                eventId: id(`${toolItem}-completed`),
                itemId: toolItem,
                createdAt,
                payload: { itemType, status: "completed", title, detail: "src/index.ts" },
              });
            }
          }
          const eventId = id(`delta-${index}`);
          const committed = new Promise<void>((resolve) =>
            waiters.set(`provider:${eventId}:assistant-delta`, resolve),
          );
          const startedAt = performance.now();
          provider.emit({
            ...base,
            type: "content.delta",
            eventId,
            itemId,
            createdAt,
            payload: { streamKind: "assistant_text", delta: assistantStreamDelta(stream, index) },
          });
          await committed;
          latencies[rep]!.push(performance.now() - startedAt);
        }
        provider.emit({
          ...base,
          type: "item.completed",
          eventId: id("message-completed"),
          itemId,
          createdAt,
          payload: { itemType: "assistant_message", status: "completed" },
        });
        provider.emit({
          ...base,
          type: "turn.completed",
          eventId: id("turn-completed"),
          createdAt,
          payload: { state: "completed" },
        });
      };
      loopDelay.enable();
      const samples = await measure(
        async () => {
          const rep = repetition++;
          latencies[rep] = [];
          await Promise.all(threadIds.map((_, stream) => runStream(stream, rep)));
          await runtime.runPromise(ingestion.drain);
          perRepetition.push({ ...counts });
        },
        method,
        async () => {
          counts.statements = counts.projectionStatements = counts.eventRows = 0;
          counts.domainEvents = 0;
        },
      );
      loopDelay.disable();

      // Correctness outside timing: every stream produced its complete text.
      const finalModel = await runtime.runPromise(engine.getReadModel());
      for (const [stream, threadId] of threadIds.entries()) {
        const message = finalModel.threads
          .find((thread) => thread.id === threadId)
          ?.messages.find(
            (entry) => entry.id === `assistant:perf-item-${stream}-${repetition - 1}`,
          );
        expect(message?.streaming).toBe(false);
        expect(message?.text).toBe(
          Array.from({ length: workload.deltasPerStream }, (_, i) =>
            assistantStreamDelta(stream, i),
          ).join(""),
        );
      }

      const measured = latencies.slice(-method.repetitions).flat();
      const measuredCounts = perRepetition.slice(-method.repetitions);
      const most = (key: keyof typeof counts) =>
        Math.max(...measuredCounts.map((entry) => entry[key]));
      const deltas = workload.threads * workload.deltasPerStream;
      return {
        samples,
        observations: [
          // Ceilings sit well above the pre-P1 baseline; the 20% gate uses perf:compare.
          maximumObservation("stream.deltaLatencyP50Ms", percentile(measured, 0.5), 250),
          maximumObservation("stream.deltaLatencyP95Ms", percentile(measured, 0.95), 500),
          maximumObservation("stream.eventRowsWritten", most("eventRows"), deltas * 2),
          maximumObservation("stream.domainEvents", most("domainEvents"), deltas * 2),
          maximumObservation("stream.sqlStatements", most("statements"), deltas * 100),
          maximumObservation(
            "stream.projectionSqlStatements",
            most("projectionStatements"),
            deltas * 50,
          ),
          // The SQLite helper-process gate trips at 100 ms p99.
          maximumObservation("stream.eventLoopDelayP99Ms", loopDelay.percentile(99) / 1e6, 100),
        ],
      };
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  } finally {
    loopDelay.disable();
    statementPrototype.all = originalAll;
    statementPrototype.run = originalRun;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Retained heap and RSS of the startup read model for a large profile. */
export async function measureReadModelMemory(): Promise<Observation[]> {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-performance-read-model-"));
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("Read-model memory measurement requires --expose-gc");
  try {
    const database = path.join(directory, "read-model.sqlite");
    const threadIds = Array.from({ length: workload.readModelThreads }, (_, i) =>
      ThreadId.makeUnsafe(`perf-read-model-${i}`),
    );
    await seed(directory, database, threadIds, workload.readModelMessages);
    const runtime = ManagedRuntime.make(
      makeLayer(directory, database, makeProviderService().service),
    );
    try {
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      gc();
      const before = process.memoryUsage();
      const model = await runtime.runPromise(query.getBootstrapSnapshot());
      gc();
      const after = process.memoryUsage();
      expect(model.threads).toHaveLength(workload.readModelThreads);
      expect(model.threads.every((t) => t.messages.length === workload.readModelMessages)).toBe(
        true,
      );
      return [
        maximumObservation(
          "readModel.heapBytes",
          Math.max(0, after.heapUsed - before.heapUsed),
          128 * 1024 * 1024,
        ),
        maximumObservation(
          "readModel.rssBytes",
          Math.max(0, after.rss - before.rss),
          256 * 1024 * 1024,
        ),
      ];
    } finally {
      await runtime.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
