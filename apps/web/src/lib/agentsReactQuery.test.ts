import { ProjectId, ProviderInstanceId, ThreadId, type AgentsSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "../types";
import {
  decodeAgentsSnapshot,
  mergeThreadSnapshot,
  selectAgentActivityThreads,
} from "./agentsReactQuery";

describe("decodeAgentsSnapshot", () => {
  it("accepts an empty durable snapshot", () => {
    expect(
      decodeAgentsSnapshot({
        entries: [],
        generatedAt: "2026-08-15T10:00:00.000Z",
      }),
    ).toEqual({
      entries: [],
      generatedAt: "2026-08-15T10:00:00.000Z",
    });
  });

  it("rejects malformed or pre-upgrade RPC responses before model derivation", () => {
    expect(() => decodeAgentsSnapshot({})).toThrow();
    expect(() => decodeAgentsSnapshot({ entries: "not-an-array" })).toThrow();
  });
});

describe("selectAgentActivityThreads", () => {
  it("only selects threads represented by the bounded agents snapshot", () => {
    const relevantThreadId = ThreadId.makeUnsafe("thread-relevant");
    const unrelatedThreadId = ThreadId.makeUnsafe("thread-with-many-unrelated-activities");
    const projectId = ProjectId.makeUnsafe("project-agents");
    const snapshot: AgentsSnapshot = {
      generatedAt: "2026-08-18T10:00:00.000Z",
      entries: [
        {
          threadId: relevantThreadId,
          workItemId: "agent-1",
          provider: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionIdentity: "codex|default",
          turnId: null,
          classification: "working",
          ownership: "direct-subagent",
          kind: "agent",
          title: null,
          prompt: null,
          lastTool: null,
          status: "running",
          active: true,
          model: null,
          phase: null,
          latestOutput: null,
          outputTruncated: false,
          startedAt: "2026-08-18T09:59:00.000Z",
          updatedAt: "2026-08-18T10:00:00.000Z",
          lastSeenAt: "2026-08-18T10:00:00.000Z",
          completedAt: null,
        },
      ],
    };
    const threads = [
      {
        id: relevantThreadId,
        projectId,
        title: "Relevant",
        activities: [],
      },
      {
        id: unrelatedThreadId,
        projectId,
        title: "Unrelated",
        activities: Array.from({ length: 100_000 }, () => null),
      },
    ] as unknown as Thread[];
    const projects = [{ id: projectId, name: "F5" }] as unknown as Project[];

    expect(selectAgentActivityThreads({ snapshot, threads, projects })).toEqual([
      expect.objectContaining({
        threadId: relevantThreadId,
        threadTitle: "Relevant",
        projectName: "F5",
        activities: [],
      }),
    ]);
  });

  it("does no activity work before the snapshot is available", () => {
    expect(selectAgentActivityThreads({ snapshot: null, threads: [], projects: [] })).toEqual([]);
  });
});

describe("mergeThreadSnapshot", () => {
  const threadId = ThreadId.makeUnsafe("thread-merge");
  const otherThreadId = ThreadId.makeUnsafe("thread-merge-other");
  const row = (
    workItemId: string,
    updatedAt: string,
    overrides: Partial<AgentsSnapshot["entries"][number]> = {},
  ): AgentsSnapshot["entries"][number] => ({
    threadId,
    workItemId,
    provider: "claudeAgent",
    providerInstanceId: null,
    providerSessionIdentity: null,
    turnId: null,
    classification: "working",
    ownership: "direct-subagent",
    kind: "agent",
    status: "running",
    active: true,
    model: null,
    phase: null,
    title: null,
    prompt: null,
    lastTool: null,
    latestOutput: null,
    outputTruncated: false,
    startedAt: "2026-08-18T10:00:00.000Z",
    updatedAt,
    lastSeenAt: updatedAt,
    completedAt: null,
    ...overrides,
  });

  it("upserts newer rows for the thread and keeps older history the push omits", () => {
    const current = {
      generatedAt: "2026-08-18T10:00:05.000Z",
      entries: [
        row("history", "2026-08-18T09:00:00.000Z", { status: "completed", active: false }),
        row("live", "2026-08-18T10:00:04.000Z"),
      ],
    };
    const pushed = {
      generatedAt: "2026-08-18T10:00:06.000Z",
      entries: [
        row("live", "2026-08-18T10:00:06.000Z", { status: "completed", active: false }),
        row("new", "2026-08-18T10:00:06.000Z"),
        row("elsewhere", "2026-08-18T10:00:06.000Z", { threadId: otherThreadId }),
      ],
    };

    const merged = mergeThreadSnapshot(current, threadId, pushed);
    expect(merged.generatedAt).toBe(pushed.generatedAt);
    expect(merged.entries.map((entry) => [entry.workItemId, entry.status]).toSorted()).toEqual([
      ["history", "completed"],
      ["live", "completed"],
      ["new", "running"],
    ]);
  });

  it("ignores pushes older than the thread snapshot", () => {
    const current = {
      generatedAt: "2026-08-18T10:00:05.000Z",
      entries: [row("live", "2026-08-18T10:00:05.000Z")],
    };
    const stale = {
      generatedAt: "2026-08-18T10:00:01.000Z",
      entries: [row("live", "2026-08-18T10:00:01.000Z", { status: "failed", active: false })],
    };
    expect(mergeThreadSnapshot(current, threadId, stale)).toBe(current);
  });
});
