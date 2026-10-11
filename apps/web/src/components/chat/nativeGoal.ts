import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface NativeGoalSummary {
  readonly objective: string;
  readonly status: string;
}

/** The thread's current provider-native goal, or null once cleared or never set. */
export function latestNativeGoal(
  activities: readonly OrchestrationThreadActivity[],
): NativeGoalSummary | null {
  const payload = activities.findLast(
    (activity) =>
      activity.kind === "native.metadata" &&
      activity.payload !== null &&
      typeof activity.payload === "object" &&
      "nativeGoal" in activity.payload,
  )?.payload as { nativeGoal?: unknown } | undefined;
  const goal = payload?.nativeGoal as { objective?: unknown; status?: unknown } | null | undefined;
  return goal && typeof goal.objective === "string" && typeof goal.status === "string"
    ? { objective: goal.objective, status: goal.status }
    : null;
}

/**
 * An active goal holds the thread's native-operation reservation until it
 * settles, so the provider rejects starting or clearing another one.
 */
export function isNativeGoalActive(goal: NativeGoalSummary | null): boolean {
  return goal?.status === "active";
}

export interface NativeGoalMenuState {
  readonly hasGoal: boolean;
  readonly active: boolean;
  readonly disabled: boolean;
}

/** Composer goal actions, or null when the session does not support native goals. */
export function resolveNativeGoalMenuState(input: {
  readonly supported: boolean;
  readonly goal: NativeGoalSummary | null;
  /** A turn is running, dispatching or reverting. */
  readonly turnBusy: boolean;
  /** A goal start or clear request has not settled yet. */
  readonly requestPending: boolean;
}): NativeGoalMenuState | null {
  if (!input.supported) return null;
  const active = isNativeGoalActive(input.goal);
  return {
    hasGoal: input.goal !== null,
    active,
    disabled: input.turnBusy || input.requestPending || active,
  };
}
