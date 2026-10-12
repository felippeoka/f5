import {
  AgentsSnapshot as AgentsSnapshotSchema,
  type AgentsDismissInput,
  type ThreadId,
} from "@t3tools/contracts";
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useMemo } from "react";

import type { AgentsPanelScope } from "../agentsPanelStore";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Project, Thread } from "../types";
import { onServerWelcome } from "../wsNativeApi";
import {
  buildAgentActivityIndex,
  deriveAgentsPanelModel,
  type AgentActivityThreadSource,
} from "./agentsModel";

export const agentsQueryKeys = {
  all: ["agents", "snapshot"] as const,
  global: ["agents", "snapshot", "all"] as const,
  threads: ["agents", "snapshot", "thread"] as const,
  thread: (threadId: ThreadId) => ["agents", "snapshot", "thread", threadId] as const,
};

type DecodedAgentsSnapshot = ReturnType<typeof decodeAgentsSnapshot>;

const EMPTY_STORE_ITEMS: readonly never[] = [];
const EMPTY_ACTIVITY_THREADS: ReadonlyArray<AgentActivityThreadSource> = [];

export function selectAgentActivityThreads(input: {
  readonly snapshot: DecodedAgentsSnapshot | null;
  readonly threads: ReadonlyArray<Thread>;
  readonly projects: ReadonlyArray<Project>;
}): ReadonlyArray<AgentActivityThreadSource> {
  if (!input.snapshot || input.snapshot.entries.length === 0) {
    return EMPTY_ACTIVITY_THREADS;
  }

  // The durable snapshot is capped and is authoritative for which work items
  // the panel can render. Restrict the expensive activity correlation to those
  // threads instead of cloning and sorting every loaded activity in the app.
  const relevantThreadIds = new Set(input.snapshot.entries.map((entry) => entry.threadId));
  const projectNameById = new Map(
    input.projects.map((project) => [project.id, project.name] as const),
  );
  return input.threads
    .filter((thread) => relevantThreadIds.has(thread.id))
    .map((thread) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      projectName: projectNameById.get(thread.projectId) ?? null,
      activities: thread.activities,
      hasOlderActivities: thread.history?.hasOlderActivities ?? false,
    }));
}

export function decodeAgentsSnapshot(value: unknown) {
  return Schema.decodeUnknownSync(AgentsSnapshotSchema)(value);
}

export function agentsSnapshotQueryOptions(threadId: ThreadId | null = null) {
  return queryOptions({
    queryKey: threadId ? agentsQueryKeys.thread(threadId) : agentsQueryKeys.global,
    queryFn: async () =>
      decodeAgentsSnapshot(
        await ensureNativeApi().agents.getSnapshot(threadId ? { threadId } : undefined),
      ),
    staleTime: 30_000,
  });
}

/**
 * Folds a global push into a thread-scoped snapshot. The push is capped across
 * all threads but always carries active and recently updated work first, so
 * upserting its rows keeps the thread view live without refetching per push.
 */
export function mergeThreadSnapshot(
  current: DecodedAgentsSnapshot,
  threadId: ThreadId,
  pushed: DecodedAgentsSnapshot,
): DecodedAgentsSnapshot {
  if (pushed.generatedAt < current.generatedAt) return current;
  const pushedForThread = pushed.entries.filter((entry) => entry.threadId === threadId);
  if (pushedForThread.length === 0) return { ...current, generatedAt: pushed.generatedAt };
  const byWorkItemId = new Map(current.entries.map((entry) => [entry.workItemId, entry] as const));
  for (const entry of pushedForThread) {
    const existing = byWorkItemId.get(entry.workItemId);
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      byWorkItemId.set(entry.workItemId, entry);
    }
  }
  return { entries: [...byWorkItemId.values()], generatedAt: pushed.generatedAt };
}

function applyPushedSnapshot(queryClient: QueryClient, decoded: DecodedAgentsSnapshot) {
  queryClient.setQueryData<DecodedAgentsSnapshot>(agentsQueryKeys.global, (current) =>
    current && current.generatedAt > decoded.generatedAt ? current : decoded,
  );
  for (const query of queryClient.getQueryCache().findAll({ queryKey: agentsQueryKeys.threads })) {
    const threadId = query.queryKey[3] as ThreadId | undefined;
    const current = query.state.data as DecodedAgentsSnapshot | undefined;
    if (!threadId || !current) continue;
    queryClient.setQueryData(query.queryKey, mergeThreadSnapshot(current, threadId, decoded));
  }
}

export async function dismissAgentWork(queryClient: QueryClient, input: AgentsDismissInput) {
  const result = await ensureNativeApi().agents.dismiss(input);
  // Dismissal removes rows, which a merged push cannot express.
  await queryClient.invalidateQueries({ queryKey: agentsQueryKeys.all, refetchType: "active" });
  return result;
}

export function useAgentsPanelModel(options: {
  readonly threadId: ThreadId;
  readonly scope: AgentsPanelScope;
  readonly includeActivityIndex?: boolean;
}) {
  const includeActivityIndex = options.includeActivityIndex ?? true;
  const queryClient = useQueryClient();
  // The global snapshot always lists live work first, so it also backs the live
  // counts for both scopes; the thread query adds that thread's full history.
  const globalQuery = useQuery(agentsSnapshotQueryOptions(null));
  const threadQuery = useQuery({
    ...agentsSnapshotQueryOptions(options.threadId),
    enabled: options.scope === "thread",
  });
  const snapshotQuery = options.scope === "thread" ? threadQuery : globalQuery;
  const threads = useStore((state) => (includeActivityIndex ? state.threads : EMPTY_STORE_ITEMS));
  const projects = useStore((state) => (includeActivityIndex ? state.projects : EMPTY_STORE_ITEMS));

  useEffect(() => {
    const api = readNativeApi();
    if (!api?.agents) return;
    return api.agents.onSnapshotUpdated((snapshot) => {
      try {
        applyPushedSnapshot(queryClient, decodeAgentsSnapshot(snapshot));
      } catch (error) {
        console.warn("Ignored an invalid agents snapshot update.", error);
      }
    });
  }, [queryClient]);

  useEffect(
    () =>
      onServerWelcome(() => {
        void queryClient.invalidateQueries({
          queryKey: agentsQueryKeys.all,
          refetchType: "active",
        });
      }),
    [queryClient],
  );

  const globalModel = useDerivedAgentsModel(
    globalQuery.data ?? null,
    includeActivityIndex,
    threads,
    projects,
  );
  const threadModel = useDerivedAgentsModel(
    options.scope === "thread" ? (threadQuery.data ?? null) : null,
    includeActivityIndex,
    threads,
    projects,
  );
  const liveCounts = useMemo(
    () => ({
      thread:
        globalModel.threads.find((group) => group.threadId === options.threadId)?.liveCount ?? 0,
      all: globalModel.liveCount,
    }),
    [globalModel, options.threadId],
  );

  return {
    model: options.scope === "thread" ? threadModel : globalModel,
    liveCounts,
    snapshotQuery,
  };
}

function useDerivedAgentsModel(
  snapshot: DecodedAgentsSnapshot | null,
  includeActivityIndex: boolean,
  threads: ReadonlyArray<Thread>,
  projects: ReadonlyArray<Project>,
) {
  const activityThreads = useMemo<ReadonlyArray<AgentActivityThreadSource>>(() => {
    if (!includeActivityIndex) return EMPTY_ACTIVITY_THREADS;
    return selectAgentActivityThreads({ snapshot, threads, projects });
  }, [includeActivityIndex, projects, snapshot, threads]);
  const activityIndex = useMemo(() => buildAgentActivityIndex(activityThreads), [activityThreads]);
  return useMemo(
    () => deriveAgentsPanelModel({ snapshot, activityIndex, threads: activityThreads }),
    [activityIndex, activityThreads, snapshot],
  );
}
