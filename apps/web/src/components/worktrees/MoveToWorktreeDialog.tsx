import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThreadId, WorktreesMoveThreadResult } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

export async function discardMovedChanges(threadId: ThreadId, operationId: string) {
  await ensureNativeApi().worktrees.discardMovedChanges({ threadId, operationId });
  toastManager.add({
    type: "success",
    title: "Original changes saved in a stash",
    description:
      "The project checkout is clean. You can restore the changes from Git's stash list.",
  });
}

export function MoveToWorktreeDialog({
  threadId,
  projectCwd,
  disabled = false,
  onClose,
}: {
  threadId: ThreadId;
  projectCwd: string;
  disabled?: boolean;
  onClose: () => void;
}) {
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["worktrees", "move-preview", threadId, projectCwd],
    queryFn: () => ensureNativeApi().git.status({ cwd: projectCwd }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["worktrees"] }),
      queryClient.invalidateQueries({ queryKey: ["git"] }),
    ]);
  const moved = (result: WorktreesMoveThreadResult) => {
    toastManager.add({
      type: "success",
      title: `Moved to ${result.branch}`,
      description: `Copied ${result.copiedFileCount} files. Originals remain in the project checkout.`,
      actionProps: {
        children: "Discard originals…",
        onClick: () => {
          void discardMovedChanges(threadId, result.operationId)
            .then(invalidate)
            .catch((cause) =>
              toastManager.add({
                type: "error",
                title: "Could not discard originals",
                description: String(cause),
              }),
            );
        },
      },
    });
  };
  const submit = async () => {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ensureNativeApi().worktrees.moveThread({
        threadId,
        ...(branch ? { branch } : {}),
      });
      moved(result);
      await invalidate();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await invalidate();
    } finally {
      setBusy(false);
    }
  };
  const count = status.data?.workingTree.files.length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Move to new worktree</DialogTitle>
          <DialogDescription>
            Uncommitted changes in the project checkout ({count ?? "…"} files), including changes
            made outside this conversation, are copied to the new worktree. The project checkout is
            not changed. Ignored files such as .env are not copied; the setup script runs in the new
            worktree on the next send when enabled for the project.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-2 text-sm">
            <span>Branch name (optional)</span>
            <Input
              autoFocus
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              disabled={busy}
              placeholder="Auto-generated"
            />
          </label>
          {(error || status.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error ?? String(status.error)}
            </p>
          )}
          {disabled && (
            <p role="status" className="text-sm">
              Wait for the active turn to finish before moving.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={disabled || busy || status.isPending || status.isError || /\s/.test(branch)}
            >
              {busy ? "Copying changes…" : "Move conversation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
