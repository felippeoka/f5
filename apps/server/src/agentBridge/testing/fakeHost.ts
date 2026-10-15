import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type CommandId,
  type NextTurnQueueSnapshot,
  type NextTurnQueueSubmitInput,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
  type TurnSubmissionResult,
} from "@t3tools/contracts";
import { Effect, PubSub, Stream } from "effect";

import type { NextTurnQueueSubmissionRecord } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import {
  AgentBridgeHostError,
  type AgentBridgeHostShape,
  type ThreadActivityAppendCommand,
} from "../AgentBridgeHost.ts";

export const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string> = ["model-a"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

export const project = (id: string, workspaceRoot = `/repo/${id}`): OrchestrationProject =>
  ({
    id,
    title: id,
    workspaceRoot,
    defaultModel: null,
    scripts: [],
    memories: [],
    skills: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  }) as unknown as OrchestrationProject;

export const thread = (
  id: string,
  projectId: string,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread =>
  ({
    id,
    projectId,
    title: id,
    model: "model-a",
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastInteractionAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    tasks: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThread;

export const emptyQueue = (threadId: string): NextTurnQueueSnapshot =>
  ({
    threadId,
    items: [],
    revision: 0,
    paused: false,
    blockedKind: null,
    reasonCode: null,
    reasonDetail: null,
    maxItems: 20,
    quarantinedCount: 0,
    unresolvedDelivery: null,
  }) as unknown as NextTurnQueueSnapshot;

/** In-memory host: records submissions and replays by submission id like the real queue. */
export class FakeAgentBridgeHost {
  projects: OrchestrationProject[] = [];
  threads: OrchestrationThread[] = [];
  providers: ServerProvider[] = [provider("codex", "codex")];
  settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
  branches = new Map<string, string | null>();
  queues = new Map<string, NextTurnQueueSnapshot>();
  records = new Map<string, NextTurnQueueSubmissionRecord>();
  submissions: NextTurnQueueSubmitInput[] = [];
  results = new Map<string, TurnSubmissionResult>();
  dispatched: ThreadActivityAppendCommand[] = [];
  /** Fails the next submission after admitting it (a crash before the reply). */
  failNextAfterAdmission = false;
  failNextBeforeAdmission: { message: string; code?: string } | null = null;
  readonly queueChanges = Effect.runSync(PubSub.unbounded<ThreadId>());
  readonly domainEvents = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());

  readonly shape: AgentBridgeHostShape = {
    readSnapshot: Effect.sync(
      () =>
        ({
          snapshotSequence: 0,
          projects: this.projects,
          threads: this.threads,
          planningWorkflows: [],
          codeReviewWorkflows: [],
          investigationWorkflows: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        }) as unknown as OrchestrationReadModel,
    ),
    getThreadDetails: (threadId) =>
      Effect.sync(() => {
        const found = this.threads.find((entry) => entry.id === threadId);
        return {
          threadId,
          messages: found?.messages ?? [],
          checkpoints: found?.checkpoints ?? [],
          tasks: [],
          tasksTurnId: null,
          tasksUpdatedAt: null,
          tasksTracking: null,
          sessionNotes: null,
          threadReferences: [],
          detailSequence: 0,
        } as never;
      }),
    getThreadDiff: ({ fromTurnCount, toTurnCount }) =>
      Effect.succeed(`diff ${fromTurnCount ?? 0}..${toTurnCount}`),
    getQueueSnapshot: (threadId) =>
      Effect.sync(() => this.queues.get(threadId) ?? emptyQueue(threadId)),
    getSubmission: (submissionId: CommandId) =>
      Effect.sync(() => this.records.get(submissionId) ?? null),
    queueChanges: Stream.fromPubSub(this.queueChanges),
    domainEvents: Stream.fromPubSub(this.domainEvents),
    listProviderInstances: Effect.sync(() => this.providers),
    getSettings: Effect.sync(() => this.settings),
    getProjectGitBranch: (cwd) =>
      Effect.sync(() => (this.branches.has(cwd) ? (this.branches.get(cwd) ?? null) : "main")),
    submitTurnSubmission: (body, options) =>
      Effect.suspend(() => {
        if (this.failNextBeforeAdmission) {
          const failure = this.failNextBeforeAdmission;
          this.failNextBeforeAdmission = null;
          return Effect.fail(new AgentBridgeHostError(failure));
        }
        if (options.submissionSource !== "automation") return Effect.die("not automation");
        const existing = this.results.get(body.submissionId);
        if (existing) return Effect.succeed(existing);
        this.submissions.push(body);
        const result: TurnSubmissionResult = {
          disposition: "started",
          submissionId: body.submissionId,
          sequence: this.submissions.length,
        };
        this.results.set(body.submissionId, result);
        if (this.failNextAfterAdmission) {
          this.failNextAfterAdmission = false;
          return Effect.fail(new AgentBridgeHostError({ message: "connection lost" }));
        }
        return Effect.succeed(result);
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        // The engine dedupes by command receipt.
        if (!this.dispatched.some((entry) => entry.commandId === command.commandId))
          this.dispatched.push(command);
      }),
  };
}
