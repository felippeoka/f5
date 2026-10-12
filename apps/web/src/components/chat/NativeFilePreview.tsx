import { useState } from "react";
import { FileDiffIcon, GitForkIcon, LoaderCircleIcon } from "lucide-react";
import type { NativeFileRewindPreview, ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

const FORK_LABEL = "Fork from this message";
const FORK_TITLE = `${FORK_LABEL} — new thread with files from the current branch tip`;
const FILES_LABEL = "Show files changed since this message";

export function NativeFilePreview(props: {
  threadId: ThreadId;
  turnId: string;
  generation: number;
  filePreview?: boolean;
  nativeFork?: boolean;
}) {
  const [preview, setPreview] = useState<NativeFileRewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"fork" | "files" | null>(null);
  const loading = pendingAction !== null;
  const load = async () => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.inspect) {
      setError("Native file preview API is unavailable.");
      return;
    }
    setPendingAction("files");
    setError(null);
    try {
      setPreview(
        (await api.inspect({
          threadId: props.threadId,
          generation: props.generation,
          kind: "filePreview",
          nativeId: props.turnId,
        })) as NativeFileRewindPreview,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "File preview is unavailable.");
    } finally {
      setPendingAction(null);
    }
  };
  const fork = async () => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.fork) {
      setError("Native fork API is unavailable.");
      return;
    }
    setPendingAction("fork");
    setError(null);
    try {
      const record = await api.fork({
        threadId: props.threadId,
        generation: props.generation,
        operationId: crypto.randomUUID(),
        beforeTurnId: props.turnId,
      });
      if (!["requested", "dispatched", "running", "completed"].includes(record.state))
        setError(record?.error ?? "Fork outcome needs reconciliation.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fork could not start.");
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5">
      {props.nativeFork && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={loading}
          onClick={() => void fork()}
          title={FORK_TITLE}
          aria-label={FORK_LABEL}
        >
          {pendingAction === "fork" ? (
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <GitForkIcon aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      )}
      {props.filePreview && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={loading}
          onClick={() => void load()}
          title={FILES_LABEL}
          aria-label={FILES_LABEL}
        >
          {pendingAction === "files" ? (
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <FileDiffIcon aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      )}
      {preview && (
        <span className="basis-full">
          {preview.canRewind
            ? `${preview.filesChanged?.join(", ") || "No tracked changes"} · +${preview.insertions ?? 0} −${preview.deletions ?? 0}`
            : (preview.error ?? "No native checkpoint is available.")}
        </span>
      )}
      {error && (
        <span role="alert" className="basis-full">
          {error}
        </span>
      )}
    </span>
  );
}
