import type { ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useCreateProjectBackedDraftThread } from "./useCreateProjectBackedDraftThread";

const SCRATCH_PROJECT_ARRIVAL_TIMEOUT_MS = 10_000;

/** Resolves once the project's creation event has reached the store. */
function projectInStore(projectId: ProjectId): Promise<void> {
  const present = () => useStore.getState().projects.some((project) => project.id === projectId);
  if (present()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The home for threads without a project did not load. Try again."));
    }, SCRATCH_PROJECT_ARRIVAL_TIMEOUT_MS);
    const unsubscribe = useStore.subscribe(() => {
      if (!present()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Opens a new thread without a project. The server owns the scratch project; it is created on
 * first use, and the thread's own folder is allocated when its first message is sent.
 */
export function useStartScratchThread() {
  const createDraftThread = useCreateProjectBackedDraftThread();
  return useCallback(async () => {
    try {
      const { projectId } = await ensureNativeApi().projects.ensureScratch();
      await projectInStore(projectId);
      return await createDraftThread(projectId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start a thread without a project",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      return null;
    }
  }, [createDraftThread]);
}
