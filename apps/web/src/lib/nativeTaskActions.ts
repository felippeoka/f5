import type {
  NativeOperationRecord,
  ProviderSessionCapabilities,
  ThreadId,
} from "@t3tools/contracts";
import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";

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

/**
 * Asks the provider to stop a child task. Resolves with the operation record,
 * or `null` when the request could not be sent. Failures surface as toasts
 * unless `silent` is set (callers batching stops report a summary instead).
 */
export async function stopNativeTask(
  target: NativeTaskTarget,
  options: { readonly silent?: boolean } = {},
): Promise<NativeOperationRecord | null> {
  const api = readNativeApi()?.nativeOperations;
  const report = (description: string) => {
    if (!options.silent) {
      toastManager.add({ type: "error", title: "Task stop failed", description });
    }
  };
  if (!api) {
    report("Native operations are unavailable.");
    return null;
  }
  try {
    const record = await api.execute({
      threadId: target.threadId,
      operationId: crypto.randomUUID(),
      generation: target.capabilities.generation,
      command: { kind: "stopTask", ...readNativeTaskIdentity(target.workItemId) },
    });
    if (record.error) report(record.error);
    return record;
  } catch (cause) {
    report(errorMessage(cause, "The native operation failed."));
    return null;
  }
}

/** The Claude adapter waits up to 30s for a stop to settle. */
const STOP_SETTLEMENT_TIMEOUT_MS = 35_000;
const STOP_SETTLEMENT_POLL_MS = 250;

/**
 * `execute` returns once the server admits an operation; the stop settles
 * later, and the thread's native-operation reservation is held until then.
 * Polls until the record leaves the in-flight states. Resolves with null if it
 * disappears, `isCancelled` reports true, or settlement times out.
 */
export async function waitForNativeOperationSettlement(
  threadId: ThreadId,
  operationId: string,
  isCancelled: () => boolean = () => false,
): Promise<NativeOperationRecord | null> {
  const api = readNativeApi()?.nativeOperations;
  if (!api) return null;
  const deadline = Date.now() + STOP_SETTLEMENT_TIMEOUT_MS;
  while (!isCancelled() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_SETTLEMENT_POLL_MS));
    if (isCancelled()) return null;
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

/**
 * Stops a task and waits for the stop to settle, so a following stop on the
 * same thread is not refused. Resolves true only for a cleanly settled stop.
 */
export async function stopNativeTaskAndSettle(
  target: NativeTaskTarget,
  isCancelled?: () => boolean,
): Promise<boolean> {
  const record = await stopNativeTask(target, { silent: true });
  if (!record || record.error) return false;
  const settled = isNativeOperationInFlight(record)
    ? await waitForNativeOperationSettlement(target.threadId, record.operationId, isCancelled)
    : record;
  return settled !== null && !settled.error && settled.state === "completed";
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
