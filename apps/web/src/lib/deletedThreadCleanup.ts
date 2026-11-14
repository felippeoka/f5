import type { ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerMentionHistoryStore } from "../composerMentionHistoryStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { readNativeApi } from "../nativeApi";

/** Only authoritative tombstones or committed result IDs may call this helper. */
export async function cleanupDeletedThread(threadId: ThreadId): Promise<void> {
  useComposerDraftStore.getState().clearThreadDraft(threadId);
  useComposerDraftStore.getState().clearDraftThread(threadId);
  useComposerMentionHistoryStore.getState().forgetThread(threadId);
  useRightPanelStore.getState().removeThread(threadId);
  useTerminalStateStore.getState().clearTerminalState(threadId);
  try {
    await readNativeApi()?.terminal.close({ threadId, deleteHistory: true });
  } catch (error) {
    console.warn("Failed to clean terminal history for deleted thread", { threadId, error });
  }
}
