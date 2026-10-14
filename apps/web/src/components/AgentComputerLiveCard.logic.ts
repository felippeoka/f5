import type { ComputerActivity, ComputerAppTier } from "@t3tools/contracts";

export type ComputerStatusTone = "ok" | "pending" | "warning" | "error" | "off";

export const COMPUTER_TIER_LABEL: Record<ComputerAppTier, string> = {
  view: "View only",
  click: "Click",
  full: "Full control",
  blocked: "Blocked",
};

const COMPUTER_ACTION_VERB: Record<string, string> = {
  screenshot: "Taking a screenshot",
  zoom: "Zooming in",
  inspect: "Reading the screen",
  click: "Clicking",
  move: "Moving the pointer",
  drag: "Dragging",
  scroll: "Scrolling",
  type: "Typing",
  key: "Pressing a key",
  elementAction: "Using a control",
  openApp: "Opening app",
  activateApp: "Switching app",
  listApps: "Listing apps",
  resolveApps: "Finding apps",
  status: "Checking status",
};

function humanizeOp(op: string): string {
  const words = op
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Working";
}

type ActivitySummary = Pick<ComputerActivity, "op" | "status">;

/** Plain-language line for what the agent is doing on the computer. */
export function describeComputerAction(
  activity: ActivitySummary | undefined,
  state: { readonly paused?: boolean | undefined; readonly held?: boolean | undefined },
): string {
  if (state.paused) return "You have control";
  if (!activity) return state.held ? "Agent is controlling this computer" : "Idle";
  const base = COMPUTER_ACTION_VERB[activity.op] ?? humanizeOp(activity.op);
  switch (activity.status) {
    case "started":
      return `${base}…`;
    case "failed":
      return `${base} failed`;
    case "interrupted":
      return `${base} was interrupted`;
    case "completed":
      return base;
  }
}

export function computerStatusTone(
  activity: ActivitySummary | undefined,
  state: { readonly paused?: boolean | undefined; readonly held?: boolean | undefined },
): ComputerStatusTone {
  if (state.paused) return "warning";
  if (activity?.status === "failed") return "error";
  if (activity?.status === "interrupted") return "warning";
  if (activity?.status === "started" || state.held) return "pending";
  if (activity?.status === "completed") return "ok";
  return "off";
}
