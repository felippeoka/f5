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
  const goal = payload?.nativeGoal;
  return goal && typeof goal === "object" && "objective" in goal && "status" in goal
    ? { objective: String(goal.objective), status: String(goal.status) }
    : null;
}
