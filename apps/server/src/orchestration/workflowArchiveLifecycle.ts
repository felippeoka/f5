import type {
  PlanningWorkflow,
  CodeReviewWorkflow,
  InvestigationWorkflow,
  OrchestrationReadModel,
  OrchestrationCommand,
  OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import {
  threadIdsForPlanningWorkflow,
  threadIdsForCodeReviewWorkflow,
  threadIdsForInvestigationWorkflow,
} from "@t3tools/shared/workflowThreads";
import { Effect } from "effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase } from "./eventBase.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import { CommandId } from "@t3tools/contracts";

type WorkflowEntry =
  | { kind: "planning"; workflow: PlanningWorkflow }
  | { kind: "codeReview"; workflow: CodeReviewWorkflow }
  | { kind: "investigation"; workflow: InvestigationWorkflow };

export function workflowThreadIds(entry: WorkflowEntry): ThreadId[] {
  switch (entry.kind) {
    case "planning":
      return threadIdsForPlanningWorkflow(entry.workflow);
    case "codeReview":
      return threadIdsForCodeReviewWorkflow(entry.workflow);
    case "investigation":
      return threadIdsForInvestigationWorkflow(entry.workflow);
  }
}

export function workflowEntries(
  model: Pick<
    OrchestrationReadModel,
    "planningWorkflows" | "codeReviewWorkflows" | "investigationWorkflows"
  >,
) {
  const entries: WorkflowEntry[] = [
    ...(model.planningWorkflows ?? []).map((workflow) => ({ kind: "planning" as const, workflow })),
    ...(model.codeReviewWorkflows ?? []).map((workflow) => ({
      kind: "codeReview" as const,
      workflow,
    })),
    ...(model.investigationWorkflows ?? []).map((workflow) => ({
      kind: "investigation" as const,
      workflow,
    })),
  ];
  return entries.map((entry) => ({
    ...entry,
    threadIds: [
      ...new Set([
        ...workflowThreadIds(entry),
        ...(entry.workflow.archiveRestorations ?? []).map((item) => item.threadId),
      ]),
    ],
  }));
}

/** One decision yields one atomic event batch; stage upserts cannot overwrite archive ownership. */
export const decideWorkflowArchive = Effect.fn("decideWorkflowArchive")(function* (input: {
  entry: WorkflowEntry;
  readModel: OrchestrationReadModel;
  command: OrchestrationCommand;
  occurredAt: string;
  operation: "archive" | "unarchive" | "preserve";
}) {
  const { readModel, command, occurredAt, operation } = input;
  const entries = workflowEntries(readModel);
  const current = entries.find(
    (entry) => entry.kind === input.entry.kind && entry.workflow.id === input.entry.workflow.id,
  )?.workflow;
  const archivedAt =
    operation === "archive"
      ? (current?.archivedAt ?? occurredAt)
      : operation === "unarchive"
        ? null
        : current
          ? current.archivedAt
          : input.entry.workflow.archivedAt;
  const restorations = [...(current?.archiveRestorations ?? [])];
  const deletedAt = current ? current.deletedAt : input.entry.workflow.deletedAt;
  const events: Omit<OrchestrationEvent, "sequence">[] = [];
  let pinRevision = readModel.pinRevision ?? 0;
  const threadBase = (threadId: ThreadId) =>
    withEventBase({
      commandId: command.commandId,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt,
    });
  const ids = new Set(workflowThreadIds(input.entry));
  if (operation === "unarchive") for (const item of restorations) ids.add(item.threadId);
  if (deletedAt !== null) ids.clear();
  for (const threadId of ids) {
    const thread = readModel.threads.find((thread) => thread.id === threadId);
    if (!thread || thread.deletedAt !== null) continue;
    if (archivedAt !== null || operation === "unarchive") {
      const conflict = entries.find(
        (entry) =>
          entry.workflow.deletedAt === null &&
          !(entry.kind === input.entry.kind && entry.workflow.id === input.entry.workflow.id) &&
          entry.threadIds.includes(threadId),
      );
      if (conflict || thread.projectId !== input.entry.workflow.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow thread ownership conflicts with another workflow or project.",
        });
      }
    }
    if (archivedAt !== null && thread.archivedAt === null) {
      const prior = restorations.findIndex((item) => item.threadId === threadId);
      const restoration = { threadId, archivedAt: occurredAt };
      if (prior < 0) restorations.push(restoration);
      else restorations[prior] = restoration;
      events.push({
        ...threadBase(threadId),
        type: "thread.archived",
        payload: {
          threadId,
          archivedAt: occurredAt,
          ...(thread.pinnedAt != null ? { pinRevision: ++pinRevision } : {}),
        },
      });
    } else if (
      operation === "unarchive" &&
      restorations.some(
        (item) => item.threadId === threadId && item.archivedAt === thread.archivedAt,
      )
    ) {
      events.push({
        ...threadBase(threadId),
        type: "thread.unarchived",
        payload: { threadId, unarchivedAt: occurredAt },
      });
    }
  }
  const patch = {
    archivedAt,
    deletedAt,
    archiveRestorations: operation === "unarchive" ? [] : restorations,
    updatedAt: occurredAt,
  };
  const base = withEventBase({
    commandId: command.commandId,
    aggregateKind: "project",
    aggregateId: input.entry.workflow.projectId,
    occurredAt,
  });
  const projectId = input.entry.workflow.projectId;
  let workflowEvent: Omit<OrchestrationEvent, "sequence">;
  switch (input.entry.kind) {
    case "planning":
      workflowEvent = {
        ...base,
        type: "project.workflow-upserted",
        payload: { projectId, workflow: { ...input.entry.workflow, ...patch } },
      };
      break;
    case "codeReview":
      workflowEvent = {
        ...base,
        type: "project.code-review-workflow-upserted",
        payload: { projectId, workflow: { ...input.entry.workflow, ...patch } },
      };
      break;
    case "investigation":
      workflowEvent = {
        ...base,
        type: "project.investigation-workflow-upserted",
        payload: { projectId, workflow: { ...input.entry.workflow, ...patch } },
      };
      break;
  }
  // Preserve the single-event shape for ordinary stage updates.
  return events.length ? [workflowEvent, ...events] : workflowEvent;
});

/** Repair old archives using commands so projections, replay and side effects agree. */
export const reconcileWorkflowArchives = (engine: OrchestrationEngineShape) =>
  Effect.gen(function* () {
    const model = yield* engine.getReadModel();
    for (const entry of workflowEntries(model)) {
      if (entry.workflow.deletedAt !== null || entry.workflow.archivedAt === null) continue;
      if (
        !model.threads.some(
          (thread) =>
            entry.threadIds.includes(thread.id) &&
            thread.deletedAt === null &&
            thread.archivedAt === null,
        )
      )
        continue;
      yield* engine.dispatch({
        type: "project.workflow.archive",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId: entry.workflow.projectId,
        workflowId: entry.workflow.id,
        workflowKind: entry.kind,
        createdAt: new Date().toISOString(),
      });
    }
  });

export const setWorkflowArchived = (
  engine: OrchestrationEngineShape,
  kind: WorkflowEntry["kind"],
  workflowId: WorkflowEntry["workflow"]["id"],
  archived: boolean,
) =>
  Effect.gen(function* () {
    const entry = workflowEntries(yield* engine.getReadModel()).find(
      (entry) =>
        entry.kind === kind &&
        entry.workflow.id === workflowId &&
        entry.workflow.deletedAt === null,
    );
    if (!entry) return yield* Effect.fail(new Error("Workflow does not exist."));
    yield* engine
      .dispatch({
        type: archived ? "project.workflow.archive" : "project.workflow.unarchive",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId: entry.workflow.projectId,
        workflowKind: kind,
        workflowId,
        createdAt: new Date().toISOString(),
      })
      .pipe(Effect.mapError((cause) => new Error(String(cause))));
  });
