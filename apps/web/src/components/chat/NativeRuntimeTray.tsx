import type {
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ProviderSessionCapabilities,
  ThreadBackgroundWorkEntry,
  ThreadId,
} from "@t3tools/contracts";
import { LightbulbIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  canInspectNativeTask,
  canStopNativeTask,
  inspectNativeTask,
  stopNativeTask,
} from "../../lib/nativeTaskActions";
import { readNativeApi } from "../../nativeApi";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { COMPOSER_TRAY_PANEL_CLASS_NAME } from "./composer/ComposerTray";
import {
  nativeOperationLabel,
  selectNativeRuntimeTrayRows,
  selectNewlyFailedOperations,
} from "./NativeRuntimeTray.logic";

const ROW_CLASS_NAME = `${COMPOSER_TRAY_PANEL_CLASS_NAME} flex items-center gap-2 text-xs`;

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const showError = (title: string, description: string) =>
  toastManager.add({ type: "error", title, description });

interface TaskInspection {
  readonly nativeId: string;
  readonly label: string;
  readonly page: unknown;
  readonly nextCursor: string | null;
}

/**
 * Native runtime rows in the composer tray: a prompt suggestion, operations
 * whose outcome needs recovery or is still running, and stoppable child
 * tasks. Renders nothing when none of those exist.
 */
interface NativeRuntimeTrayProps {
  threadId: ThreadId;
  capabilities: ProviderSessionCapabilities | null | undefined;
  activities: readonly OrchestrationThreadActivity[];
  prompt: string;
  latestMessageAt?: string | undefined;
  onSuggestion: (text: string) => void;
}

export function NativeRuntimeTray(props: NativeRuntimeTrayProps) {
  // Per-thread state (records, open dialogs) must never leak into another thread.
  return <NativeRuntimeTrayContent key={props.threadId} {...props} />;
}

function NativeRuntimeTrayContent(props: NativeRuntimeTrayProps) {
  const { threadId, capabilities, activities, prompt } = props;
  const [records, setRecords] = useState<readonly NativeOperationRecord[]>([]);
  const [tasks, setTasks] = useState<readonly ThreadBackgroundWorkEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [usedSuggestionId, setUsedSuggestionId] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<NativeOperationRecord | null>(null);
  const [inspection, setInspection] = useState<TaskInspection | null>(null);
  const [reading, setReading] = useState(false);
  const [mountedAt] = useState(() => new Date().toISOString());
  const mutationVersion = useRef(0);
  const reportedFailures = useRef(new Set<string>());
  const previousRecords = useRef(records);
  const canInspectTasks = canInspectNativeTask(capabilities);
  const canStopTasks = canStopNativeTask(capabilities);
  const rows = selectNativeRuntimeTrayRows({
    activities,
    prompt,
    latestMessageAt: props.latestMessageAt,
    usedSuggestionId,
    records,
    tasks,
    canInspectTasks,
    canStopTasks,
  });
  const shownSuggestionId = rows.find((row) => row.kind === "suggestion")?.id ?? null;
  const shownSuggestionBefore = useRef(shownSuggestionId);
  const promptBefore = useRef(prompt);
  useEffect(() => {
    // Typing passes on the suggestion that was on screen before the edit,
    // not one that arrived together with it.
    if (promptBefore.current !== prompt && shownSuggestionBefore.current) {
      setUsedSuggestionId(shownSuggestionBefore.current);
    }
    promptBefore.current = prompt;
  }, [prompt]);
  useEffect(() => {
    shownSuggestionBefore.current = shownSuggestionId;
  });
  useEffect(() => {
    for (const record of selectNewlyFailedOperations({
      previous: previousRecords.current,
      next: records,
      mountedAt,
      reported: reportedFailures.current,
    })) {
      reportedFailures.current.add(record.operationId);
      showError(
        `${nativeOperationLabel(record.command.kind)} failed`,
        record.error ?? "The provider reported a failure.",
      );
    }
    previousRecords.current = records;
  }, [records, mountedAt]);
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      const api = readNativeApi();
      if (!api?.nativeOperations) return;
      refreshing = true;
      try {
        const version = mutationVersion.current;
        const [next, snapshot] = await Promise.all([
          api.nativeOperations.list({ threadId }),
          api.agents.getSnapshot(),
        ]);
        if (alive) {
          // A poll that started before a local receipt is older than that
          // receipt; the next poll replaces the list authoritatively.
          if (version === mutationVersion.current) setRecords(next);
          setTasks(snapshot.entries.filter((entry) => entry.threadId === threadId));
        }
      } catch {
        /* Connection and capability surfaces already report transport failures. */
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, capabilities?.generation]);

  const stop = async (workItemId: string) => {
    if (!capabilities || busy) return;
    setBusy(true);
    try {
      const record = await stopNativeTask({ threadId, capabilities, workItemId });
      if (!record) return;
      mutationVersion.current++;
      if (record.error) reportedFailures.current.add(record.operationId);
      setRecords((current) => [
        record,
        ...current.filter((entry) => entry.operationId !== record.operationId),
      ]);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (record: NativeOperationRecord, action: "reconcile" | "acknowledge") => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.resolve || !capabilities || busy) return;
    setBusy(true);
    try {
      const next = await api.resolve({
        threadId,
        operationId: record.operationId,
        generation: capabilities.generation,
        action,
      });
      mutationVersion.current++;
      setRecords((current) =>
        current.map((entry) => (entry.operationId === next.operationId ? next : entry)),
      );
    } catch (cause) {
      showError("Outcome resolution failed", errorMessage(cause, "Outcome resolution failed."));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (nativeId: string, label: string, cursor?: string) => {
    if (!capabilities) return;
    setReading(true);
    try {
      const result = await inspectNativeTask(
        { threadId, capabilities, workItemId: nativeId },
        cursor,
      );
      if (result) setInspection({ nativeId, label, ...result });
    } finally {
      setReading(false);
    }
  };

  if (!capabilities) return null;

  return (
    <>
      {rows.map((row) => {
        switch (row.kind) {
          case "suggestion":
            return (
              <div key={`suggestion:${row.id}`} className={ROW_CLASS_NAME}>
                <LightbulbIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  Suggested: <span className="text-foreground">{row.summary}</span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setUsedSuggestionId(row.id);
                    props.onSuggestion(row.summary);
                  }}
                >
                  Use
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss suggestion"
                  onClick={() => setUsedSuggestionId(row.id)}
                >
                  <XIcon />
                </Button>
              </div>
            );
          case "recovery": {
            const { record } = row;
            return (
              <div key={`recovery:${record.operationId}`} className={ROW_CLASS_NAME}>
                <TriangleAlertIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-warning-foreground"
                />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">
                    {nativeOperationLabel(record.command.kind)} outcome is uncertain
                  </span>
                  <span className="text-muted-foreground">
                    {record.staleGeneration ? " · result belongs to an older session" : ""}
                    {record.error ? ` · ${record.error}` : ""}
                    {record.command.kind === "fork"
                      ? ` · Preserved workspace: ${record.command.cwd}`
                      : ""}
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resolve(record, "reconcile")}
                >
                  Recheck outcome
                </Button>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => setAcknowledging(record)}
                >
                  {row.finishAcknowledgement
                    ? "Finish acknowledgement"
                    : "Stop provider and acknowledge"}
                </Button>
              </div>
            );
          }
          case "running":
            return (
              <div
                key={`running:${row.record.operationId}`}
                className={`${ROW_CLASS_NAME} text-muted-foreground`}
              >
                <Spinner aria-hidden className="size-3.5 shrink-0" />
                {nativeOperationLabel(row.record.command.kind)} running…
              </div>
            );
          case "task": {
            const { task } = row;
            const label = task.title ?? task.phase ?? task.workItemId;
            return (
              <div key={`task:${task.workItemId}`} className={ROW_CLASS_NAME}>
                <Spinner aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {label} <span className="text-muted-foreground">· {task.status}</span>
                </span>
                {canInspectTasks && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={reading}
                    onClick={() => void inspect(task.workItemId, label)}
                  >
                    Inspect output
                  </Button>
                )}
                {canStopTasks && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void stop(task.workItemId)}
                  >
                    Stop
                  </Button>
                )}
              </div>
            );
          }
        }
      })}
      <AlertDialog
        open={acknowledging !== null}
        onOpenChange={(open) => {
          if (!open) setAcknowledging(null);
        }}
      >
        <AlertDialogPopup className="sm:max-w-[460px]">
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle>Accept this uncertain outcome?</AlertDialogTitle>
            <AlertDialogDescription>
              Stop the provider and accept this uncertain outcome? Files, conversation or forks may
              already have changed. F5 will release the reservation without repeating the operation.
              Inspect any affected workspace before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const record = acknowledging;
                setAcknowledging(null);
                if (record) void resolve(record, "acknowledge");
              }}
            >
              Stop provider and acknowledge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={inspection !== null}
        onOpenChange={(open) => {
          if (!open) setInspection(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">Output · {inspection?.label}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">
              {JSON.stringify(inspection?.page ?? null, null, 2)}
            </pre>
          </DialogPanel>
          {inspection?.nextCursor ? (
            <DialogFooter variant="bare">
              <Button
                size="sm"
                variant="outline"
                disabled={reading}
                onClick={() =>
                  void inspect(inspection.nativeId, inspection.label, inspection.nextCursor!)
                }
              >
                Next page
              </Button>
            </DialogFooter>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
