import type {
  NativeOperationRecord,
  ProviderSessionCapabilities,
  ThreadId,
} from "@t3tools/contracts";
import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";

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
