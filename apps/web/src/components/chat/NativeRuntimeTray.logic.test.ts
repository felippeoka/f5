import type {
  NativeOperationCommand,
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describeBackgroundTask,
  formatByteSize,
  readShellOutputPage,
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

const task = (workItemId: string, active: boolean, startedAt = "2026-01-01T00:00:00Z") =>
  ({
    workItemId,
    active,
    startedAt,
    status: active ? "running" : "completed",
  }) as ThreadBackgroundWorkEntry;

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

    it("groups only active tasks into one row, oldest first", () => {
      const later = task("later", true, "2026-01-01T00:05:00Z");
      expect(selectNativeRuntimeTrayRows({ ...base, tasks: [later, ...tasks] })).toMatchObject([
        { kind: "tasks", tasks: [{ workItemId: "live" }, { workItemId: "later" }] },
      ]);
    });

    it("yields no row when no task is active", () => {
      expect(kinds({ tasks: [task("done", false)] })).toEqual([]);
    });

    it("hides tasks when the provider can neither inspect nor stop them", () => {
      expect(kinds({ tasks, canInspectTasks: false, canStopTasks: false })).toEqual([]);
      expect(kinds({ tasks, canInspectTasks: false })).toEqual(["tasks"]);
    });
  });
});

describe("describeBackgroundTask", () => {
  const nowMs = Date.parse("2026-01-01T00:03:12Z");
  const entry = (overrides: Partial<ThreadBackgroundWorkEntry> = {}) =>
    ({
      ownership: "direct-subagent",
      classification: "monitoring",
      phase: "local_bash",
      latestOutput: "Run full browser suite",
      startedAt: "2026-01-01T00:00:00Z",
      ...overrides,
    }) as ThreadBackgroundWorkEntry;
  const describeEntry = (overrides: Partial<ThreadBackgroundWorkEntry> = {}) =>
    describeBackgroundTask(entry(overrides), nowMs);

  it("names a background shell by its description", () => {
    expect(describeEntry()).toEqual({
      kind: "shell",
      kindLabel: "Shell",
      title: "Run full browser suite",
      agentName: null,
      elapsed: "3m 12s",
    });
    expect(describeEntry({ phase: "shell" }).kind).toBe("shell");
  });

  it("maps monitors, agents and workflows", () => {
    expect(describeEntry({ phase: "monitor_mcp" }).kind).toBe("monitor");
    // Progress replaces a monitor's phase with its last tool name.
    expect(describeEntry({ phase: "Read" }).kind).toBe("monitor");
    // Progress replaces an agent's phase with its last tool name.
    expect(describeEntry({ classification: "working", phase: "Read" }).kind).toBe("agent");
    expect(describeEntry({ ownership: "workflow", classification: "working" }).kind).toBe(
      "workflow",
    );
  });

  it("uses the first non-empty line, capped", () => {
    expect(describeEntry({ latestOutput: "\n  Watch typecheck  \nmore" }).title).toBe(
      "Watch typecheck",
    );
    const title = describeEntry({ latestOutput: "x".repeat(200) }).title;
    expect(title).toHaveLength(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to the kind when there is no description", () => {
    expect(describeEntry({ latestOutput: null }).title).toBe("Background shell");
    expect(describeEntry({ latestOutput: "local_bash" }).title).toBe("Background shell");
    expect(describeEntry({ phase: "monitor", latestOutput: "  " }).title).toBe("Monitor");
    expect(describeEntry({ classification: "working", latestOutput: null }).title).toBe(
      "Agent task",
    );
  });

  it("keeps a Codex subagent's path when it has no description", () => {
    // `subagent.activity` rows store the agent path in phase and no output.
    expect(
      describeEntry({
        workItemId: "subagent:thread-2",
        classification: "working",
        phase: "/root/reviewer",
        latestOutput: null,
      }),
    ).toMatchObject({ kind: "agent", title: "/root/reviewer", agentName: "/root/reviewer" });
  });

  it("keeps a Claude agent's type next to its description or result", () => {
    const running = describeEntry({
      classification: "working",
      phase: "Explore",
      latestOutput: "Find tray rendering",
    });
    expect(running).toMatchObject({ title: "Find tray rendering", agentName: "Explore" });
    const settled = describeEntry({
      classification: "working",
      phase: "Explore",
      latestOutput: "## Findings\n\n- The tray renders `task.phase`.",
    });
    expect(settled).toMatchObject({ title: "Findings", agentName: "Explore" });
    expect(
      describeEntry({ classification: "working", phase: "local_agent", latestOutput: null }),
    ).toMatchObject({ title: "Agent task", agentName: null });
  });

  it("omits elapsed time for an invalid or future start", () => {
    expect(describeEntry({ startedAt: "not a date" }).elapsed).toBeNull();
    expect(describeEntry({ startedAt: "2026-01-01T01:00:00Z" }).elapsed).toBeNull();
  });
});

describe("readShellOutputPage", () => {
  it("reads a bounded shell tail", () => {
    expect(
      readShellOutputPage({
        entries: [{ output: "ok\n", totalBytes: 41_873, omitted: true }],
        nextCursor: null,
      }),
    ).toEqual({ output: "ok\n", totalBytes: 41_873, omitted: true });
  });

  it("treats a tail shorter than the total as cut, even without the SDK flag", () => {
    // The server slices the tail itself and only forwards the SDK's flag.
    expect(
      readShellOutputPage({ entries: [{ output: "tail", totalBytes: 20_480, omitted: false }] }),
    ).toMatchObject({ omitted: true });
    expect(
      readShellOutputPage({ entries: [{ output: "é", totalBytes: 2, omitted: false }] }),
    ).toMatchObject({ omitted: false });
  });

  it("rejects other output shapes", () => {
    expect(readShellOutputPage(null)).toBeNull();
    expect(readShellOutputPage({ entries: [] })).toBeNull();
    expect(readShellOutputPage({ entries: [{ role: "assistant", text: "hi" }] })).toBeNull();
    expect(
      readShellOutputPage({
        entries: [
          { output: "a", totalBytes: 1 },
          { output: "b", totalBytes: 1 },
        ],
      }),
    ).toBeNull();
  });
});

describe("formatByteSize", () => {
  it("shows bytes below 1 KB and kilobytes above", () => {
    expect(formatByteSize(36)).toBe("36 B");
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(8192)).toBe("8 KB");
    expect(formatByteSize(41_873)).toBe("41 KB");
  });
});
