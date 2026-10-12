import { ProjectId, ProviderInstanceId, ThreadId, type AgentsSnapshot } from "@t3tools/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, Thread } from "../types";
import {
  agentsQueryKeys,
  applyPushedSnapshot,
  decodeAgentsSnapshot,
  selectAgentActivityThreads,
  THREAD_SNAPSHOT_REFRESH_MS,
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

describe("applyPushedSnapshot", () => {
  const threadId = ThreadId.makeUnsafe("thread-merge");
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

  const snapshotAt = (generatedAt: string, entries: AgentsSnapshot["entries"]) => ({
    generatedAt,
    entries,
  });

  /** A thread query with an active observer, fed by `responses` in order. */
  function observeThread(
    queryClient: QueryClient,
    responses: ReadonlyArray<() => Promise<AgentsSnapshot>>,
  ) {
    let calls = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: agentsQueryKeys.thread(threadId),
      queryFn: () => responses[Math.min(calls++, responses.length - 1)]!(),
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    return { calls: () => calls, unsubscribe };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces the global snapshot and refetches thread snapshots once per burst", async () => {
    const queryClient = new QueryClient();
    const initial = snapshotAt("2026-08-18T10:00:00.000Z", [
      row("live", "2026-08-18T10:00:00.000Z"),
      row("dismissed-elsewhere", "2026-08-18T09:00:00.000Z", { active: false }),
    ]);
    // The refetch drops the row another client dismissed and settles the live one.
    const refreshed = snapshotAt("2026-08-18T10:00:02.000Z", [
      row("live", "2026-08-18T10:00:02.000Z", { status: "completed", active: false }),
    ]);
    const thread = observeThread(queryClient, [
      () => Promise.resolve(initial),
      () => Promise.resolve(refreshed),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(thread.calls()).toBe(1);

    // A capped global push that leaves this thread out entirely.
    const pushed = snapshotAt("2026-08-18T10:00:01.000Z", []);
    applyPushedSnapshot(queryClient, pushed);
    applyPushedSnapshot(queryClient, pushed);
    applyPushedSnapshot(queryClient, pushed);
    expect(queryClient.getQueryData(agentsQueryKeys.global)).toBe(pushed);

    await vi.advanceTimersByTimeAsync(THREAD_SNAPSHOT_REFRESH_MS);
    expect(thread.calls()).toBe(2);
    expect(queryClient.getQueryData(agentsQueryKeys.thread(threadId))).toEqual(refreshed);
    thread.unsubscribe();
  });

  it("does not lose a push that arrives during the first thread fetch", async () => {
    const queryClient = new QueryClient();
    let resolveStale: (value: AgentsSnapshot) => void = () => {};
    const stale = snapshotAt("2026-08-18T10:00:00.000Z", [row("live", "2026-08-18T10:00:00.000Z")]);
    const fresh = snapshotAt("2026-08-18T10:00:03.000Z", [
      row("live", "2026-08-18T10:00:03.000Z", { status: "completed", active: false }),
    ]);
    const thread = observeThread(queryClient, [
      () => new Promise<AgentsSnapshot>((resolve) => (resolveStale = resolve)),
      () => Promise.resolve(fresh),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    applyPushedSnapshot(queryClient, snapshotAt("2026-08-18T10:00:03.000Z", []));
    await vi.advanceTimersByTimeAsync(THREAD_SNAPSHOT_REFRESH_MS);
    resolveStale(stale);
    await vi.advanceTimersByTimeAsync(0);

    expect(thread.calls()).toBe(2);
    expect(queryClient.getQueryData(agentsQueryKeys.thread(threadId))).toEqual(fresh);
    thread.unsubscribe();
  });
});
