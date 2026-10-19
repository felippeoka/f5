import { CommandId, ThreadId, PlanningWorkflow } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { applyArchiveTestCommand, workflowArchiveFixture } from "./workflowArchive.testUtils.ts";
import { reconcileWorkflowArchives, workflowEntries } from "./workflowArchiveLifecycle.ts";
import {
  summarizePlanningWorkflow,
  summarizeCodeReviewWorkflow,
  summarizeInvestigationWorkflow,
} from "@t3tools/shared/workflowSummary";

describe.each(["planning", "codeReview", "investigation"] as const)(
  "workflow archive (%s)",
  (kind) => {
    it("archives children and restores only unchanged children archived by the workflow", () => {
      const fixture = workflowArchiveFixture(kind);
      let model = applyArchiveTestCommand(fixture.model, {
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("independent"),
        threadId: fixture.b,
        createdAt: "2026-10-10T10:00:00.000Z",
      }).model;
      const result = applyArchiveTestCommand(model, fixture.archive());
      model = result.model;
      expect(result.events.map((event) => event.type)).toEqual([
        workflowEntries(model)[0]!.kind === "planning"
          ? "project.workflow-upserted"
          : kind === "codeReview"
            ? "project.code-review-workflow-upserted"
            : "project.investigation-workflow-upserted",
        "thread.archived",
      ]);
      expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toEqual([
        { threadId: fixture.a, archivedAt: "2026-10-19T10:00:00.000Z" },
      ]);
      expect(applyArchiveTestCommand(model, fixture.archive()).events).toHaveLength(1);
      expect(() =>
        applyArchiveTestCommand(model, {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("direct"),
          threadId: fixture.a,
          createdAt: "2026-10-19T10:01:00.000Z",
        }),
      ).toThrow("Restore the owning workflow");
      model = applyArchiveTestCommand(model, fixture.archive(true)).model;
      expect(model.threads.find((thread) => thread.id === fixture.a)?.archivedAt).toBeNull();
      expect(model.threads.find((thread) => thread.id === fixture.b)?.archivedAt).toBe(
        "2026-10-10T10:00:00.000Z",
      );
      expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toEqual([]);
    });

    it("preserves independent later archives and skips deleted children", () => {
      const fixture = workflowArchiveFixture(kind);
      let model = applyArchiveTestCommand(fixture.model, fixture.archive()).model;
      model = {
        ...model,
        threads: model.threads.map((thread) =>
          thread.id === fixture.a
            ? { ...thread, archivedAt: "2026-10-20T10:00:00.000Z" }
            : { ...thread, deletedAt: "2026-10-20T10:00:00.000Z" },
        ),
      };
      const result = applyArchiveTestCommand(model, fixture.archive(true));
      expect(result.events).toHaveLength(1);
      expect(result.model.threads[0]!.archivedAt).toBe("2026-10-20T10:00:00.000Z");
    });

    it("rejects ownership conflicts before producing any changes", () => {
      const fixture = workflowArchiveFixture(kind);
      const other = workflowArchiveFixture(kind === "codeReview" ? "investigation" : "codeReview");
      const model = {
        ...fixture.model,
        codeReviewWorkflows: [
          ...fixture.model.codeReviewWorkflows,
          ...other.model.codeReviewWorkflows,
        ],
        investigationWorkflows: [
          ...fixture.model.investigationWorkflows,
          ...other.model.investigationWorkflows,
        ],
      };
      expect(() => applyArchiveTestCommand(model, fixture.archive())).toThrow(
        "ownership conflicts",
      );
      expect(model.threads.every((thread) => thread.archivedAt === null)).toBe(true);
    });

    it("repairs legacy archives through commands and a second repair does no work", async () => {
      const fixture = workflowArchiveFixture(kind);
      let model = applyArchiveTestCommand(fixture.model, fixture.archive()).model;
      model = {
        ...model,
        threads: model.threads.map((thread) => ({ ...thread, archivedAt: null })),
      };
      const commands: unknown[] = [];
      const engine = {
        getReadModel: () => Effect.succeed(model),
        dispatch: (command: Parameters<typeof applyArchiveTestCommand>[1]) =>
          Effect.sync(() => {
            commands.push(command);
            model = applyArchiveTestCommand(model, command).model;
            return { sequence: model.snapshotSequence };
          }),
      };
      await Effect.runPromise(reconcileWorkflowArchives(engine as never));
      await Effect.runPromise(reconcileWorkflowArchives(engine as never));
      expect(commands).toHaveLength(1);
      expect(model.threads.every((thread) => thread.archivedAt !== null)).toBe(true);
    });
  },
);

it("preserves archive ownership across stale stage upserts and archives new children", () => {
  const fixture = workflowArchiveFixture("codeReview");
  let model = applyArchiveTestCommand(fixture.model, fixture.archive()).model;
  const newId = ThreadId.makeUnsafe("consolidation");
  model = {
    ...model,
    threads: [...model.threads, { ...model.threads[0]!, id: newId, archivedAt: null }],
  };
  const original = fixture.model.codeReviewWorkflows[0]!;
  model = applyArchiveTestCommand(model, {
    type: "project.code-review-workflow.upsert",
    commandId: CommandId.makeUnsafe("stale"),
    projectId: original.projectId,
    updatedAt: "2026-10-19T11:00:00.000Z",
    workflow: { ...original, consolidation: { ...original.consolidation, threadId: newId } },
  }).model;
  expect(model.codeReviewWorkflows[0]!.archivedAt).not.toBeNull();
  expect(model.codeReviewWorkflows[0]!.archiveRestorations).toHaveLength(3);
  expect(model.threads.find((thread) => thread.id === newId)?.archivedAt).not.toBeNull();
  const stale = model.codeReviewWorkflows[0]!;
  model = applyArchiveTestCommand(model, fixture.archive(true)).model;
  model = applyArchiveTestCommand(model, {
    type: "project.code-review-workflow.upsert",
    commandId: CommandId.makeUnsafe("stale-after-restore"),
    projectId: stale.projectId,
    workflow: stale,
    updatedAt: "2026-10-19T12:00:00.000Z",
  }).model;
  expect(model.codeReviewWorkflows[0]!.archivedAt).toBeNull();
  expect(model.codeReviewWorkflows[0]!.archiveRestorations).toEqual([]);
});

it("omits restoration metadata from all lightweight summaries", () => {
  for (const kind of ["planning", "codeReview", "investigation"] as const) {
    const fixture = workflowArchiveFixture(kind);
    const entry = workflowEntries(
      applyArchiveTestCommand(fixture.model, fixture.archive()).model,
    )[0]!;
    const summary =
      entry.kind === "planning"
        ? summarizePlanningWorkflow(entry.workflow)
        : entry.kind === "codeReview"
          ? summarizeCodeReviewWorkflow(entry.workflow)
          : summarizeInvestigationWorkflow(entry.workflow);
    expect(summary).not.toHaveProperty("archiveRestorations");
  }
});

it("archives implementation, review and reader history exactly once, skipping absent children", () => {
  const fixture = workflowArchiveFixture("planning");
  const ids = ["implementation", "implementation-review", "reader", "previous-reader"].map(
    ThreadId.makeUnsafe,
  );
  const original = fixture.model.planningWorkflows[0]!;
  const workflow = Schema.decodeUnknownSync(PlanningWorkflow)({
    ...original,
    readerPass: {
      status: "completed",
      draftTurnId: "draft",
      draftPlanId: "plan",
      readerThreadId: ids[2],
      previousReaderThreadIds: [ids[3], fixture.a, ThreadId.makeUnsafe("missing")],
      updatedAt: original.updatedAt,
    },
    implementation: {
      implementationSlot: original.branchA.authorSlot,
      threadId: ids[0],
      implementationTurnId: null,
      revisionTurnId: null,
      status: "completed",
      error: null,
      updatedAt: original.updatedAt,
      codeReviews: [
        {
          reviewerLabel: "Reviewer",
          reviewerSlot: original.branchA.authorSlot,
          threadId: ids[1],
          status: "completed",
          error: null,
          updatedAt: original.updatedAt,
        },
      ],
    },
  });
  const model = {
    ...fixture.model,
    planningWorkflows: [workflow],
    threads: [...fixture.model.threads, ...ids.map((id) => ({ ...fixture.model.threads[0]!, id }))],
  };
  const result = applyArchiveTestCommand(model, fixture.archive());
  expect(result.events.filter((event) => event.type === "thread.archived")).toHaveLength(6);
  expect(result.model.planningWorkflows[0]!.archiveRestorations).toHaveLength(6);
  expect(result.model.threads.every((thread) => thread.archivedAt !== null)).toBe(true);
});

it("uses the normal thread archive lifecycle for pins and snoozes", () => {
  const fixture = workflowArchiveFixture("planning");
  const model = {
    ...fixture.model,
    threads: fixture.model.threads.map((thread, index) => ({
      ...thread,
      pinnedAt: "2026-10-18T00:00:00.000Z",
      pinOrderKey: index,
      snoozedAt: "2026-10-18T00:00:00.000Z",
      snoozedUntil: "2026-10-20T00:00:00.000Z",
    })),
  };
  const result = applyArchiveTestCommand(model, fixture.archive());
  expect(result.model.pinRevision).toBe(2);
  expect(
    result.model.threads.every(
      (thread) =>
        thread.pinnedAt === null && thread.snoozedUntil === null && thread.snoozedAt === null,
    ),
  ).toBe(true);
});
