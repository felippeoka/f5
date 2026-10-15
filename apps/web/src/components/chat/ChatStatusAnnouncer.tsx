import type { OrchestrationLatestTurnState } from "@t3tools/contracts";
import { useState } from "react";

export type ChatStatusOutcome =
  | "working"
  | "awaiting-approval"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";

export function deriveChatStatusOutcome(input: {
  readonly isWorking: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasBlockingUserInput: boolean;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
}): ChatStatusOutcome {
  if (input.hasPendingApproval) return "awaiting-approval";
  if (input.hasBlockingUserInput) return "awaiting-input";
  if (input.isWorking || input.latestTurnState === "running") return "working";
  switch (input.latestTurnState) {
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    default:
      return "idle";
  }
}

const OUTCOME_MESSAGES: Record<Exclude<ChatStatusOutcome, "idle">, string> = {
  working: "Working",
  "awaiting-approval": "Waiting for your approval",
  "awaiting-input": "Waiting for your input",
  completed: "Response ready",
  failed: "Response failed",
  interrupted: "Response stopped",
};

const MAX_REMEMBERED_TRANSITIONS = 32;

interface AnnouncerState {
  readonly threadId: string;
  readonly lastOutcome: ChatStatusOutcome;
  /** `turnId:outcome` transitions already announced in this thread. */
  readonly announced: ReadonlyArray<string>;
  readonly message: string;
}

/**
 * One polite live region for coarse turn transitions. Each turn's outcome is
 * announced once: opening a thread reads nothing, streaming tokens never
 * speak, and a reconnect that briefly reports "working" does not replay an
 * outcome the reader already heard.
 */
export function ChatStatusAnnouncer(props: {
  threadId: string;
  turnId: string | null;
  outcome: ChatStatusOutcome;
}) {
  const [state, setState] = useState<AnnouncerState>(() => ({
    threadId: props.threadId,
    lastOutcome: props.outcome,
    announced: [`${props.turnId}:${props.outcome}`],
    message: "",
  }));

  if (state.threadId !== props.threadId) {
    setState({
      threadId: props.threadId,
      lastOutcome: props.outcome,
      announced: [`${props.turnId}:${props.outcome}`],
      message: "",
    });
  } else if (state.lastOutcome !== props.outcome) {
    const key = `${props.turnId}:${props.outcome}`;
    const shouldAnnounce = props.outcome !== "idle" && !state.announced.includes(key);
    setState({
      threadId: state.threadId,
      lastOutcome: props.outcome,
      announced: shouldAnnounce
        ? [...state.announced, key].slice(-MAX_REMEMBERED_TRANSITIONS)
        : state.announced,
      message:
        shouldAnnounce && props.outcome !== "idle"
          ? OUTCOME_MESSAGES[props.outcome]
          : state.message,
    });
  }

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {state.message}
    </div>
  );
}
