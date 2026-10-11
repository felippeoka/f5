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
  try {
    await readNativeApi()?.preview.automation.setPaused({ threadId, paused });
  } catch (error) {
    const bridge = window.desktopBridge?.computerAutomation;
    if (paused || !bridge) throw error;
    await bridge.setPaused(threadId, false);
    return; // The authoritative main echo updates both stores.
  }
  if (!paused) useAgentBrowserActivityStore.getState().setPaused(threadId, false);
}
