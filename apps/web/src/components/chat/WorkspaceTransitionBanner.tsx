import type {
  ThreadId,
  WorkspaceTransitionRecoveryPreview,
  WorktreesResolveTransitionInput,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { Button } from "../ui/button";

export function WorkspaceTransitionBanner({ threadId }: { threadId: ThreadId }) {
  const revision = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot?.revision);
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<WorkspaceTransitionRecoveryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transition = useQuery({
    queryKey: ["worktrees", "transition", threadId, revision],
    queryFn: () => ensureNativeApi().worktrees.getTransition({ threadId }),
    staleTime: 0,
  });
  const pushed = useNextTurnQueueStore(
    (state) => state.byThreadId[threadId]?.snapshot?.workspaceTransition,
  );
  const record =
    pushed && (!transition.data || pushed.updatedAt >= transition.data.updatedAt)
      ? pushed
      : transition.data;
  if (!record || ["completed", "cancelled"].includes(record.phase)) return null;
  const active = !["needs_recovery", "failed"].includes(record.phase);
  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await ensureNativeApi().worktrees.previewTransitionRecovery({
          operationId: record.operationId,
        }),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (action: WorktreesResolveTransitionInput["action"]) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ensureNativeApi().worktrees.resolveTransition({
        operationId: record.operationId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action,
      });
      setPreview(null);
      if (result.phase !== "completed")
        setError(result.error ?? "Workspace switching needs attention.");
      await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      await queryClient.invalidateQueries({ queryKey: ["git"] });
    } catch (cause) {
      setPreview(null);
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      className="space-y-2 rounded border border-warning/40 bg-warning/5 p-3 text-sm"
    >
      <p>
        {active
          ? "Switching workspace. Sending is blocked until it finishes."
          : "Workspace switching needs attention. Your files have been kept."}
      </p>
      {record.error && <p className="break-words text-xs">{record.error}</p>}
      <p className="break-all font-mono text-xs">
        {record.source.path} → {record.target.path}
      </p>
      {!active && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void inspect()}>
          Inspect workspace
        </Button>
      )}
      {preview && (
        <div className="space-y-2">
          <p className="break-all">
            Inspected:{" "}
            {preview.actual
              ? `${preview.actual.branch ?? "detached HEAD"} · ${preview.actual.headSha ?? "no commit"} · ${preview.actual.path}`
              : "Target unavailable"}
          </p>
          {preview.blockedReasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                busy ||
                !preview.actual ||
                preview.blockedReasons.length > 0 ||
                preview.transition.phase === "failed"
              }
              onClick={() => void resolve("accept_inspected_workspace")}
            >
              Accept inspected workspace
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !preview.original ||
                preview.original.repository !== preview.transition.source.repository ||
                preview.original.branch !== preview.transition.source.branch ||
                preview.original.headSha !== preview.transition.source.headSha
              }
              onClick={() => void resolve("keep_original_workspace")}
            >
              Keep original workspace
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !preview.projectCheckout || preview.transition.phase === "failed"}
              onClick={() => void resolve("use_project_checkout")}
            >
              Continue in project checkout
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !preview.canRetry}
              onClick={() => void resolve("retry")}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
