import {
  ThreadId,
  type NativeOperationRecord,
  type ProviderSessionCapabilities,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ execute: vi.fn(), list: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("../nativeApi", () => ({ readNativeApi: () => ({ nativeOperations: api }) }));
vi.mock("../components/ui/toast", () => ({ toastManager: toast }));

import {
  isNativeTaskStopBlocked,
  nativeTaskStopKey,
  stopNativeTasks,
  useNativeTaskStopStore,
  type NativeTaskTarget,
} from "./nativeTaskActions";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const capabilities = {
  generation: 3,
  discovery: "succeeded",
  checkedAt: "2026-08-18T10:00:00.000Z",
  actions: [],
} as unknown as ProviderSessionCapabilities;

const target = (threadId: ThreadId, workItemId: string): NativeTaskTarget => ({
  threadId,
  capabilities,
  workItemId,
});

function record(
  operationId: string,
  threadId: ThreadId,
  state: NativeOperationRecord["state"],
  error?: string,
): NativeOperationRecord {
  return {
    threadId,
    operationId,
    generation: 3,
    command: { kind: "stopTask", taskId: "task" },
    state,
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...(error ? { error } : {}),
  };
}

/** Admits each stop as running, then lists it in `settled` state. */
function admitThenSettle(
  settled: (call: number) => { state: NativeOperationRecord["state"]; error?: string },
) {
  let call = 0;
  const records = new Map<string, NativeOperationRecord>();
  api.execute.mockImplementation(async (input: { operationId: string; threadId: ThreadId }) => {
    const outcome = settled(call++);
    records.set(
      input.operationId,
      record(input.operationId, input.threadId, outcome.state, outcome.error),
    );
    return record(input.operationId, input.threadId, "running");
  });
  api.list.mockImplementation(async ({ threadId }: { threadId: ThreadId }) =>
    [...records.values()].filter((entry) => entry.threadId === threadId),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  api.execute.mockReset();
  api.list.mockReset();
  toast.add.mockReset();
  useNativeTaskStopStore.setState({ pending: new Set() });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("stopNativeTasks", () => {
  it("clears the pending stop and reports a stop that fails after it was admitted", async () => {
    admitThenSettle(() => ({ state: "failed", error: "This running task is no longer owned." }));
    const run = stopNativeTasks([target(THREAD_A, "task-1")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      useNativeTaskStopStore.getState().pending.has(nativeTaskStopKey(THREAD_A, "task-1")),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    await run;
    expect(useNativeTaskStopStore.getState().pending.size).toBe(0);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Task stop failed",
        description: "This running task is no longer owned.",
      }),
    );
  });

  it("gives up after the settlement timeout and releases the pending state", async () => {
    api.execute.mockImplementation(async (input: { operationId: string; threadId: ThreadId }) =>
      record(input.operationId, input.threadId, "running"),
    );
    api.list.mockImplementation(async ({ threadId }: { threadId: ThreadId }) => [
      record(String(api.execute.mock.calls[0]![0].operationId), threadId, "running"),
    ]);
    const run = stopNativeTasks([target(THREAD_A, "task-1")]);
    await vi.advanceTimersByTimeAsync(36_000);
    await run;
    expect(useNativeTaskStopStore.getState().pending.size).toBe(0);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ description: "The stop did not finish in time." }),
    );
  });

  it("waits for each stop to settle before sending the next and reports a summary", async () => {
    admitThenSettle(() => ({ state: "completed" }));
    const run = stopNativeTasks([target(THREAD_A, "task-1"), target(THREAD_A, "task-2")]);
    await vi.advanceTimersByTimeAsync(0);
    // The second stop waits for the first one's settlement.
    expect(api.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(api.execute).toHaveBeenCalledTimes(2);
    expect(toast.add).toHaveBeenCalledWith({ type: "success", title: "Stopped 2 tasks" });
    expect(useNativeTaskStopStore.getState().pending.size).toBe(0);
  });

  it("skips the rest of a thread after an uncertain stop but continues elsewhere", async () => {
    admitThenSettle((call) => (call === 0 ? { state: "indeterminate" } : { state: "completed" }));
    const run = stopNativeTasks([
      target(THREAD_A, "task-1"),
      target(THREAD_A, "task-2"),
      target(THREAD_B, "task-3"),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(api.execute.mock.calls.map(([input]) => input.threadId)).toEqual([THREAD_A, THREAD_B]);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Some tasks could not be stopped",
        description: expect.stringContaining("1 stopped, 2 failed."),
      }),
    );
  });

  it("does not send a second stop for a task that is already stopping", async () => {
    admitThenSettle(() => ({ state: "completed" }));
    const first = stopNativeTasks([target(THREAD_A, "task-1")]);
    const second = stopNativeTasks([target(THREAD_A, "task-1")]);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
    expect(api.execute).toHaveBeenCalledTimes(1);
  });
});

describe("isNativeTaskStopBlocked", () => {
  it("blocks other tasks in a thread with a pending stop, not the task itself or other threads", () => {
    const pending = new Set([nativeTaskStopKey(THREAD_A, "task-1")]);
    expect(isNativeTaskStopBlocked(pending, THREAD_A, "task-2")).toBe(true);
    expect(isNativeTaskStopBlocked(pending, THREAD_A, "task-1")).toBe(false);
    expect(isNativeTaskStopBlocked(pending, THREAD_B, "task-3")).toBe(false);
  });
});
