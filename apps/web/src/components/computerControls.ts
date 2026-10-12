import { useAgentBrowserActivityStore } from "../agentBrowserActivityStore";
import type { ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "../lib/utils";
export async function stopComputerTurn(threadId: ThreadId): Promise<void> {
  try {
    await window.desktopBridge?.computerAutomation?.setPaused(threadId, true);
  } finally {
    await readNativeApi()?.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  }
}
export async function pauseComputerThread(threadId: ThreadId, paused: boolean): Promise<void> {
  const bridge = window.desktopBridge?.computerAutomation;
  if (!paused && !bridge) throw new Error("Resume on the computer running F5.");
  await bridge?.setPaused(threadId, paused);
  // Main sends the authoritative resume notification only after its checks succeed.
  if (paused) await readNativeApi()?.preview.automation.setPaused({ threadId, paused });
}

/** Preview resume shares the pause latch; computer-bound threads need local approval. */
export async function pausePreviewThread(threadId: ThreadId, paused: boolean): Promise<void> {
  if (paused) useAgentBrowserActivityStore.getState().setPaused(threadId, true);
  // Preload consumes the trusted click synchronously. Starting this after the
  // WebSocket reply can expire the gesture before main sees the resume request.
  const bridge = window.desktopBridge?.computerAutomation;
  const localResume =
    !paused && bridge
      ? bridge.setPaused(threadId, false).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : undefined;
  try {
    await readNativeApi()?.preview.automation.setPaused({ threadId, paused });
  } catch (error) {
    if (!localResume) throw error;
    const result = await localResume;
    if (!result.ok) throw result.error;
    return; // The authoritative main echo updates both stores.
  }
  if (!paused) useAgentBrowserActivityStore.getState().setPaused(threadId, false);
}
