import type {
  NativeOperationCommand,
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";

import { formatDuration } from "../../session-logic";

export type NativeRuntimeTrayRow =
  | { readonly kind: "suggestion"; readonly id: string; readonly summary: string }
  | {
      readonly kind: "recovery";
      readonly record: NativeOperationRecord;
      /** A cancelled file revert only needs its acknowledgement finished. */
      readonly finishAcknowledgement: boolean;
    }
  | { readonly kind: "running"; readonly record: NativeOperationRecord }
  | { readonly kind: "tasks"; readonly tasks: readonly ThreadBackgroundWorkEntry[] };

export type BackgroundTaskKind = "shell" | "monitor" | "agent" | "workflow";

export interface BackgroundTaskDescription {
  readonly kind: BackgroundTaskKind;
  readonly kindLabel: string;
  readonly title: string;
  readonly elapsed: string | null;
}

const BACKGROUND_TASK_KINDS: Record<
  BackgroundTaskKind,
  { readonly label: string; readonly fallbackTitle: string }
> = {
  shell: { label: "Shell", fallbackTitle: "Background shell" },
  monitor: { label: "Monitor", fallbackTitle: "Monitor" },
  agent: { label: "Agent", fallbackTitle: "Agent task" },
  workflow: { label: "Workflow", fallbackTitle: "Workflow" },
};

const MAX_TASK_TITLE_LENGTH = 120;

function backgroundTaskKind(
  task: Pick<ThreadBackgroundWorkEntry, "ownership" | "classification" | "phase">,
): BackgroundTaskKind {
  if (task.ownership === "workflow") return "workflow";
  // Progress events overwrite `phase` with the last tool name, so the stable
  // classification decides between shells and agents.
  if (task.classification === "monitoring") {
    return task.phase?.toLowerCase().startsWith("monitor") ? "monitor" : "shell";
  }
  return "agent";
}

function backgroundTaskTitle(
  task: Pick<ThreadBackgroundWorkEntry, "latestOutput" | "phase">,
): string | null {
  const line = task.latestOutput
    ?.split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line || line === task.phase) return null;
  return line.length > MAX_TASK_TITLE_LENGTH
    ? `${line.slice(0, MAX_TASK_TITLE_LENGTH - 1).trimEnd()}…`
    : line;
}

/**
 * User-facing name for a background task. The provider's task type
 * (`local_bash`) and internal status (`monitoring`) are not shown.
 */
export function describeBackgroundTask(
  task: Pick<
    ThreadBackgroundWorkEntry,
    "ownership" | "classification" | "phase" | "latestOutput" | "startedAt"
  >,
  nowMs: number,
): BackgroundTaskDescription {
  const kind = backgroundTaskKind(task);
  const meta = BACKGROUND_TASK_KINDS[kind];
  const startedAt = Date.parse(task.startedAt);
  return {
    kind,
    kindLabel: meta.label,
    title: backgroundTaskTitle(task) ?? meta.fallbackTitle,
    elapsed:
      Number.isNaN(startedAt) || startedAt > nowMs ? null : formatDuration(nowMs - startedAt),
  };
}

export interface ShellOutputPage {
  readonly output: string;
  readonly totalBytes: number;
  readonly omitted: boolean;
}

/** The bounded output tail a provider returns for a background shell. */
export function readShellOutputPage(page: unknown): ShellOutputPage | null {
  if (!page || typeof page !== "object" || !("entries" in page)) return null;
  const { entries } = page;
  if (!Array.isArray(entries) || entries.length !== 1) return null;
  const entry: unknown = entries[0];
  if (!entry || typeof entry !== "object") return null;
  const { output, totalBytes, omitted } = entry as Record<string, unknown>;
  if (typeof output !== "string" || typeof totalBytes !== "number") return null;
  return { output, totalBytes, omitted: omitted === true };
}

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
    const tasks = input.tasks
      .filter((task) => task.active)
      .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
    if (tasks.length > 0) rows.push({ kind: "tasks", tasks });
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
