import { useNavigate } from "@tanstack/react-router";
import type { AgentComputerUseChanged, AgentComputerUseHolder } from "@t3tools/contracts";
import { MonitorIcon, SquareIcon } from "lucide-react";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { pauseComputerThread, stopComputerTurn } from "./computerControls";

const PAUSE_CAUSE_LABEL: Record<NonNullable<AgentComputerUseHolder["pauseCause"]>, string> = {
  paused: "",
  "kill-switch": "stop shortcut",
  "user-input": "you used the mouse or keyboard",
  "permit-expired": "F5 lost contact with the helper",
  "target-active": "you are using that app",
  activation: "an app changed focus",
  "outcome-unknown": "last action's result is unknown",
  "access-changed": "access changed",
};

/** The holder the banner speaks for: foreground control first, then the first background one. */
export function primaryComputerHolder(
  leases: typeof AgentComputerUseChanged.Type,
): AgentComputerUseHolder | undefined {
  return leases.holders.find((holder) => holder.delivery === "foreground") ?? leases.holders[0];
}

/** Threads the banner text speaks for: every active background agent when it summarizes them. */
export function computerUseBannerTargets(
  leases: typeof AgentComputerUseChanged.Type,
): ReadonlyArray<AgentComputerUseHolder["threadId"]> {
  const holder = primaryComputerHolder(leases);
  if (!holder) return [];
  if (holder.delivery === "foreground" || holder.state !== "active") return [holder.threadId];
  return leases.holders
    .filter((entry) => entry.delivery === "background")
    .map((entry) => entry.threadId);
}
export function computerUseBannerText(
  leases: typeof AgentComputerUseChanged.Type,
  pausedLocally: boolean,
): string | null {
  const pending = leases.pendingTakeover;
  if (pending) {
    const app = pending.appName ?? "an app";
    return pending.state === "waiting-idle"
      ? `An agent will take over ${app} when you stop using the mouse and keyboard`
      : `An agent is asking to take over ${app}`;
  }
  const holder = primaryComputerHolder(leases);
  if (!holder)
    return leases.otherProfile
      ? "An agent in another F5 profile is controlling this computer"
      : null;
  const app = holder.appName ?? (holder.appId ? "an app" : undefined);
  const cause = holder.pauseCause ? PAUSE_CAUSE_LABEL[holder.pauseCause] : "";
  const state = pausedLocally && holder.state === "active" ? "paused" : holder.state;
  switch (state) {
    case "paused":
      return `Computer control paused${cause ? ` · ${cause}` : ""}`;
    case "recovery":
      return `Computer control stopped${app ? ` · check ${app} before resuming` : ""}${cause ? ` · ${cause}` : ""}`;
    case "waiting-secure-input":
      return `Agent waiting${app ? ` in ${app}` : ""} while secure text entry is active`;
    case "pending-consent":
    case "waiting-idle":
    case "active":
      break;
  }
  if (holder.delivery === "foreground")
    return holder.appId
      ? `An agent is controlling ${app} in the foreground`
      : "An agent is controlling this computer";
  const background = leases.holders.filter((entry) => entry.delivery === "background");
  if (background.length <= 1) return `An agent is working in ${app ?? "an app"} in the background`;
  const apps = [...new Set(background.flatMap((entry) => (entry.appName ? [entry.appName] : [])))];
  return `${background.length} agents are working in the background${apps.length ? ` in ${apps.join(", ")}` : ""}`;
}

export function ComputerUseBanner() {
  const leases = useAgentComputerActivityStore((state) => state.leases);
  const holder = primaryComputerHolder(leases);
  const threadId = leases.pendingTakeover?.threadId ?? holder?.threadId;
  const paused = useAgentComputerActivityStore((state) =>
    threadId ? !!state.paused[threadId] : false,
  );
  const navigate = useNavigate();
  const title = useStore((store) =>
    threadId ? store.threads.find((thread) => thread.id === threadId)?.title : undefined,
  );
  const text = computerUseBannerText(leases, paused);
  if (!text) return null;
  // Background-only control is ambient: a quieter style, no takeover of the user's attention.
  const ambient =
    !leases.pendingTakeover &&
    !leases.otherProfile &&
    holder?.delivery === "background" &&
    holder.state === "active" &&
    !paused;
  const backend = holder?.backend;
  // A summary of several background agents controls all of them; otherwise just the one shown.
  const summarized = leases.pendingTakeover ? [] : computerUseBannerTargets(leases);
  const targets = summarized.length > 1 ? summarized : threadId ? [threadId] : [];
  return (
    <div
      role="status"
      className={
        ambient
          ? "fixed top-2 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 py-1 pr-1 pl-3 text-muted-foreground text-sm shadow-sm"
          : "fixed top-2 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning/50 bg-background/95 py-1 pr-1 pl-3 text-sm shadow-md"
      }
      data-testid="computer-use-banner"
      data-delivery={holder?.delivery}
    >
      <MonitorIcon className={ambient ? "size-4" : "size-4 text-warning-foreground"} />
      <span>
        {text}
        {title ? ` · ${title}` : ""}
        {backend ? ` · ${backend === "native" ? "F5" : backend}` : ""}
      </span>
      {threadId ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/$threadId", params: { threadId } })}
          >
            View
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title="Stop shortcut: ⌃⌘Esc on macOS; Ctrl+Alt+Shift+F12 on Windows"
            onClick={() => {
              for (const target of targets)
                void pauseComputerThread(target, !paused).catch(() => undefined);
            }}
          >
            {paused ? "Resume" : targets.length > 1 ? "Pause all" : "Pause"}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            title={backend === "native" ? "Stop computer input" : "Stops after the current action"}
            onClick={() => {
              for (const target of targets) void stopComputerTurn(target).catch(() => undefined);
            }}
          >
            <SquareIcon />
            {targets.length > 1 ? "Stop all" : "Stop"}
          </Button>
        </>
      ) : (
        <span className="text-xs">⌃⌘Esc / Ctrl+Alt+Shift+F12 to stop</span>
      )}
    </div>
  );
}
