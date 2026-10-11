import type {
  NativeOperationCommand,
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";

export type NativeRuntimeTrayRow =
  | { readonly kind: "suggestion"; readonly id: string; readonly summary: string }
  | {
      readonly kind: "recovery";
      readonly record: NativeOperationRecord;
      /** A cancelled file revert only needs its acknowledgement finished. */
      readonly finishAcknowledgement: boolean;
    }
  | { readonly kind: "running"; readonly record: NativeOperationRecord }
  | { readonly kind: "task"; readonly task: ThreadBackgroundWorkEntry };

const RUNNING_STATES: ReadonlySet<NativeOperationRecord["state"]> = new Set([
  "requested",
  "dispatched",
  "running",
]);

const OPERATION_LABELS: Record<NativeOperationCommand["kind"], string> = {
  compact: "Compaction",
  review: "Review",
  stopTask: "Task stop",
  revertFiles: "File revert",
  fork: "Fork",
  goalSet: "Goal start",
  goalPause: "Goal pause",
  goalClear: "Goal clear",
};

export function nativeOperationLabel(kind: NativeOperationCommand["kind"]): string {
  return OPERATION_LABELS[kind];
}

export function latestPromptSuggestion(
  activities: readonly OrchestrationThreadActivity[],
): OrchestrationThreadActivity | undefined {
  return activities.findLast((entry) => entry.kind === "prompt.suggestion");
}

/**
 * Rows worth showing above the composer. Everything informational (model,
 * warnings, goal status) already has a home elsewhere, so an idle thread
 * yields no rows and the tray collapses.
 */
export function selectNativeRuntimeTrayRows(input: {
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly prompt: string;
  readonly latestMessageAt: string | undefined;
  readonly usedSuggestionId: string | null;
  readonly records: readonly NativeOperationRecord[];
  readonly tasks: readonly ThreadBackgroundWorkEntry[];
  readonly canInspectTasks: boolean;
  readonly canStopTasks: boolean;
}): NativeRuntimeTrayRow[] {
  const rows: NativeRuntimeTrayRow[] = [];
  const suggestion = latestPromptSuggestion(input.activities);
  if (
    suggestion &&
    input.usedSuggestionId !== suggestion.id &&
    !input.prompt &&
    (!input.latestMessageAt || suggestion.createdAt > input.latestMessageAt)
  ) {
    rows.push({ kind: "suggestion", id: suggestion.id, summary: suggestion.summary });
  }
  for (const record of input.records) {
    if (record.state === "indeterminate") {
      rows.push({ kind: "recovery", record, finishAcknowledgement: false });
    } else if (record.state === "cancelled" && record.command.kind === "revertFiles") {
      rows.push({ kind: "recovery", record, finishAcknowledgement: true });
    }
  }
  for (const record of input.records) {
    // A started goal stays `running` until it settles, possibly for hours;
    // the header already shows its status.
    if (RUNNING_STATES.has(record.state) && record.command.kind !== "goalSet") {
      rows.push({ kind: "running", record });
    }
  }
  if (input.canInspectTasks || input.canStopTasks) {
    for (const task of input.tasks) {
      if (task.active) rows.push({ kind: "task", task });
    }
  }
  return rows;
}

/**
 * Operations that failed after admission and have not been reported yet:
 * either seen in a non-failed state before, or created while the tray was
 * mounted. Older failures in the server history stay quiet.
 */
export function selectNewlyFailedOperations(input: {
  readonly previous: readonly NativeOperationRecord[];
  readonly next: readonly NativeOperationRecord[];
  readonly mountedAt: string;
  readonly reported: ReadonlySet<string>;
}): NativeOperationRecord[] {
  return input.next.filter(
    (record) =>
      record.state === "failed" &&
      !input.reported.has(record.operationId) &&
      (record.createdAt >= input.mountedAt ||
        input.previous.some(
          (entry) => entry.operationId === record.operationId && entry.state !== "failed",
        )),
  );
}
