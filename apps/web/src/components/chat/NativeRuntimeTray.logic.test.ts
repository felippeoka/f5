import type {
  NativeOperationCommand,
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  selectNativeRuntimeTrayRows,
  selectNewlyFailedOperations,
} from "./NativeRuntimeTray.logic";

const suggestion = (id: string, createdAt: string) =>
  ({
    id,
    kind: "prompt.suggestion",
    summary: `Try ${id}`,
    createdAt,
  }) as OrchestrationThreadActivity;

const record = (
  operationId: string,
  state: NativeOperationRecord["state"],
  command: NativeOperationCommand = { kind: "compact" },
) => ({ operationId, state, command }) as NativeOperationRecord;

const task = (workItemId: string, active: boolean) =>
  ({ workItemId, active, status: active ? "running" : "completed" }) as ThreadBackgroundWorkEntry;

const base = {
  activities: [],
  prompt: "",
  latestMessageAt: undefined,
  usedSuggestionId: null,
  records: [],
  tasks: [],
  canInspectTasks: true,
  canStopTasks: true,
} satisfies Parameters<typeof selectNativeRuntimeTrayRows>[0];

const kinds = (input: Partial<Parameters<typeof selectNativeRuntimeTrayRows>[0]>) =>
  selectNativeRuntimeTrayRows({ ...base, ...input }).map((row) => row.kind);

describe("selectNativeRuntimeTrayRows", () => {
  it("yields nothing for an idle thread", () => {
    expect(kinds({})).toEqual([]);
  });

  describe("prompt suggestion", () => {
    const activities = [
      suggestion("old", "2026-01-01T00:00:00Z"),
      suggestion("s", "2026-01-02T00:00:00Z"),
    ];

    it("shows only the latest suggestion", () => {
      expect(selectNativeRuntimeTrayRows({ ...base, activities })).toEqual([
        { kind: "suggestion", id: "s", summary: "Try s" },
      ]);
    });

    it("hides it while the prompt has text", () => {
      expect(kinds({ activities, prompt: "draft" })).toEqual([]);
    });

    it("hides it once used or dismissed", () => {
      expect(kinds({ activities, usedSuggestionId: "s" })).toEqual([]);
    });

    it("hides it when a newer message exists", () => {
      expect(kinds({ activities, latestMessageAt: "2026-01-03T00:00:00Z" })).toEqual([]);
      expect(kinds({ activities, latestMessageAt: "2026-01-01T12:00:00Z" })).toEqual([
        "suggestion",
      ]);
    });
  });

  describe("operations", () => {
    it("asks for recovery of an indeterminate operation", () => {
      expect(
        selectNativeRuntimeTrayRows({ ...base, records: [record("a", "indeterminate")] }),
      ).toMatchObject([{ kind: "recovery", finishAcknowledgement: false }]);
    });

    it("asks to finish acknowledging a cancelled file revert", () => {
      const revert = record("a", "cancelled", { kind: "revertFiles", userMessageId: "m" });
      expect(selectNativeRuntimeTrayRows({ ...base, records: [revert] })).toMatchObject([
        { kind: "recovery", finishAcknowledgement: true },
      ]);
    });

    it("ignores settled operations", () => {
      expect(
        kinds({
          records: [record("a", "completed"), record("b", "failed"), record("c", "cancelled")],
        }),
      ).toEqual([]);
    });

    it("reports running operations after recoveries", () => {
      expect(
        kinds({
          records: [
            record("a", "running"),
            record("b", "requested"),
            record("c", "dispatched"),
            record("d", "indeterminate"),
          ],
        }),
      ).toEqual(["recovery", "running", "running", "running"]);
    });

    it("leaves a started goal to the header instead of a long-lived spinner", () => {
      const goal = record("g", "running", { kind: "goalSet", objective: "Ship", tokenBudget: 10 });
      expect(kinds({ records: [goal] })).toEqual([]);
      expect(kinds({ records: [{ ...goal, state: "indeterminate" }] })).toEqual(["recovery"]);
    });
  });

  describe("selectNewlyFailedOperations", () => {
    const mountedAt = "2026-01-02T00:00:00Z";
    const at = (state: NativeOperationRecord["state"], createdAt: string, id = "op") =>
      ({ ...record(id, state), createdAt }) as NativeOperationRecord;
    const failed = (input: Partial<Parameters<typeof selectNewlyFailedOperations>[0]>) =>
      selectNewlyFailedOperations({
        previous: [],
        next: [],
        mountedAt,
        reported: new Set(),
        ...input,
      }).map((entry) => entry.operationId);

    it("reports an admitted operation that later fails", () => {
      expect(
        failed({
          previous: [at("running", "2026-01-01T00:00:00Z")],
          next: [at("failed", "2026-01-01T00:00:00Z")],
        }),
      ).toEqual(["op"]);
    });

    it("reports a failure created after mount even if never seen running", () => {
      expect(failed({ next: [at("failed", "2026-01-03T00:00:00Z")] })).toEqual(["op"]);
    });

    it("stays quiet about old failures and already reported ones", () => {
      expect(failed({ next: [at("failed", "2026-01-01T00:00:00Z")] })).toEqual([]);
      expect(
        failed({
          previous: [at("running", "2026-01-03T00:00:00Z")],
          next: [at("failed", "2026-01-03T00:00:00Z")],
          reported: new Set(["op"]),
        }),
      ).toEqual([]);
    });
  });

  describe("child tasks", () => {
    const tasks = [task("live", true), task("done", false)];

    it("lists only active tasks", () => {
      expect(selectNativeRuntimeTrayRows({ ...base, tasks })).toMatchObject([
        { kind: "task", task: { workItemId: "live" } },
      ]);
    });

    it("hides tasks when the provider can neither inspect nor stop them", () => {
      expect(kinds({ tasks, canInspectTasks: false, canStopTasks: false })).toEqual([]);
      expect(kinds({ tasks, canInspectTasks: false })).toEqual(["task"]);
    });
  });
});
