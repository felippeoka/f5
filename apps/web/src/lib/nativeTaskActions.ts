import type {
  NativeOperationRecord,
  ProviderSessionCapabilities,
  ThreadId,
} from "@t3tools/contracts";
import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";
import { create } from "zustand";

import { isNativeOperationInFlight } from "../components/chat/NativeRuntimeTray.logic";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";

/** A provider action is usable only when the live session reports it as supported. */
export function supportsNativeAction(
  capabilities: ProviderSessionCapabilities | null | undefined,
  action: string,
): boolean {
  return capabilities?.actions.some((entry) => entry.action === action && entry.supported) === true;
}

export function canStopNativeTask(
  capabilities: ProviderSessionCapabilities | null | undefined,
): boolean {
  return supportsNativeAction(capabilities, "childTaskStop");
}

export function canInspectNativeTask(
  capabilities: ProviderSessionCapabilities | null | undefined,
): boolean {
  return supportsNativeAction(capabilities, "childTaskInspection");
}

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

export interface NativeTaskTarget {
  readonly threadId: ThreadId;
  readonly capabilities: ProviderSessionCapabilities;
  /** Durable background-work id; may carry a `subagent:` prefix or a run suffix. */
  readonly workItemId: string;
}

/** The Claude adapter waits up to 30s for a stop to settle. */
const STOP_SETTLEMENT_TIMEOUT_MS = 35_000;
const STOP_SETTLEMENT_POLL_MS = 250;

/**
 * `execute` returns once the server admits an operation; the stop settles
 * later, and the thread's native-operation reservation is held until then.
 * Polls until the record leaves the in-flight states. Resolves with null if it
 * disappears or settlement times out.
 */
async function waitForNativeOperationSettlement(
  threadId: ThreadId,
  operationId: string,
): Promise<NativeOperationRecord | null> {
  const api = readNativeApi()?.nativeOperations;
  if (!api) return null;
  const deadline = Date.now() + STOP_SETTLEMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_SETTLEMENT_POLL_MS));
    try {
      const record = (await api.list({ threadId })).find(
        (entry) => entry.operationId === operationId,
      );
      if (!record) return null;
      if (!isNativeOperationInFlight(record)) return record;
    } catch {
      /* A transient poll failure retries until the deadline. */
    }
  }
  return null;
}

type StopOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      /** The thread's reservation may still be held, so later stops there would be refused. */
      readonly blocksThread: boolean;
    };

/** Sends one stop and waits until the provider settles it. */
async function stopAndSettle(target: NativeTaskTarget): Promise<StopOutcome> {
  const api = readNativeApi()?.nativeOperations;
  if (!api) {
    return { ok: false, error: "Native operations are unavailable.", blocksThread: false };
  }
  let record: NativeOperationRecord;
  try {
    record = await api.execute({
      threadId: target.threadId,
      operationId: crypto.randomUUID(),
      generation: target.capabilities.generation,
      command: { kind: "stopTask", ...readNativeTaskIdentity(target.workItemId) },
    });
  } catch (cause) {
    return {
      ok: false,
      error: errorMessage(cause, "The native operation failed."),
      blocksThread: false,
    };
  }
  const settled = isNativeOperationInFlight(record)
    ? await waitForNativeOperationSettlement(target.threadId, record.operationId)
    : record;
  if (!settled) {
    return { ok: false, error: "The stop did not finish in time.", blocksThread: true };
  }
  if (settled.state === "completed" && !settled.error) return { ok: true };
  if (settled.state === "indeterminate") {
    return {
      ok: false,
      error: settled.error ?? "The stop outcome is uncertain. Recheck it from the composer.",
      blocksThread: true,
    };
  }
  return {
    ok: false,
    error: settled.error ?? "The provider did not stop the task.",
    blocksThread: false,
  };
}

export function nativeTaskStopKey(threadId: ThreadId, workItemId: string): string {
  return `${threadId}\u0000${workItemId}`;
}

interface NativeTaskStopState {
  /** Stops sent and not yet settled, keyed by `nativeTaskStopKey`. */
  readonly pending: ReadonlySet<string>;
}

/**
 * Pending stops live outside any component: a stop keeps running, and is
 * reported, after the panel that started it closes.
 */
export const useNativeTaskStopStore = create<NativeTaskStopState>(() => ({
  pending: new Set(),
}));

function setStopPending(key: string, pending: boolean) {
  useNativeTaskStopStore.setState((state) => {
    if (state.pending.has(key) === pending) return state;
    const next = new Set(state.pending);
    if (pending) next.add(key);
    else next.delete(key);
    return { pending: next };
  });
}

/**
 * A thread holds one native-operation reservation until a stop settles, so
 * while any stop is pending there, other tasks in that thread can't be stopped.
 */
export function isNativeTaskStopBlocked(
  pending: ReadonlySet<string>,
  threadId: ThreadId,
  workItemId: string,
): boolean {
  const prefix = `${threadId}\u0000`;
  const own = nativeTaskStopKey(threadId, workItemId);
  for (const key of pending) {
    if (key !== own && key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Stops tasks one at a time, waiting for each stop to settle, and reports the
 * outcome with a toast. Tasks already being stopped are skipped. After a stop
 * that may still hold its thread's reservation, the remaining tasks in that
 * thread are reported as failed instead of being refused one by one.
 */
export async function stopNativeTasks(targets: ReadonlyArray<NativeTaskTarget>): Promise<void> {
  const queued = targets.filter(
    (target) =>
      !useNativeTaskStopStore
        .getState()
        .pending.has(nativeTaskStopKey(target.threadId, target.workItemId)),
  );
  if (queued.length === 0) return;
  const keys = queued.map((target) => nativeTaskStopKey(target.threadId, target.workItemId));
  for (const key of keys) setStopPending(key, true);

  let stopped = 0;
  let lastError: string | null = null;
  const blockedThreads = new Set<ThreadId>();
  for (const [index, target] of queued.entries()) {
    try {
      if (blockedThreads.has(target.threadId)) {
        lastError = "An earlier stop in this thread has not finished.";
        continue;
      }
      const outcome = await stopAndSettle(target);
      if (outcome.ok) {
        stopped += 1;
      } else {
        lastError = outcome.error;
        if (outcome.blocksThread) blockedThreads.add(target.threadId);
      }
    } finally {
      setStopPending(keys[index]!, false);
    }
  }

  const failed = queued.length - stopped;
  if (queued.length === 1) {
    if (failed > 0) {
      toastManager.add({ type: "error", title: "Task stop failed", description: lastError ?? "" });
    }
    return;
  }
  toastManager.add(
    failed === 0
      ? { type: "success", title: `Stopped ${stopped} tasks` }
      : {
          type: "error",
          title: "Some tasks could not be stopped",
          description: `${stopped} stopped, ${failed} failed.${lastError ? ` ${lastError}` : ""}`,
        },
  );
}

export interface NativeTaskInspection {
  readonly page: unknown;
  readonly nextCursor: string | null;
}

/** Reads one page of a child task's native output. */
export async function inspectNativeTask(
  target: NativeTaskTarget,
  cursor?: string,
): Promise<NativeTaskInspection | null> {
  const api = readNativeApi()?.nativeOperations;
  if (!api?.inspect) {
    toastManager.add({
      type: "error",
      title: "Task output unavailable",
      description: "Native output API is unavailable.",
    });
    return null;
  }
  try {
    const identity = readNativeTaskIdentity(target.workItemId);
    const page = await api.inspect({
      threadId: target.threadId,
      generation: target.capabilities.generation,
      kind: "task",
      nativeId: identity.taskId,
      ...(identity.runId ? { runId: identity.runId } : {}),
      limit: 20,
      ...(cursor ? { cursor } : {}),
    });
    const nextCursor =
      page && typeof page === "object" && "nextCursor" in page ? page.nextCursor : null;
    return { page, nextCursor: typeof nextCursor === "string" ? nextCursor : null };
  } catch (cause) {
    toastManager.add({
      type: "error",
      title: "Task output unavailable",
      description: errorMessage(cause, "Native output is unavailable."),
    });
    return null;
  }
}
