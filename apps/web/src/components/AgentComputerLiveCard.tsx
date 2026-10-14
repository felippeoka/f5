import { useEffect, useMemo, useState } from "react";
import type { ComputerAccessPush, ComputerGrant, ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  ClockIcon,
  HistoryIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  useAgentComputerActivityStore,
  isAgentComputerActive,
} from "../agentComputerActivityStore";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import {
  COMPUTER_TIER_LABEL,
  computerStatusTone,
  describeComputerAction,
  type ComputerStatusTone,
} from "./AgentComputerLiveCard.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { pauseComputerThread, stopComputerTurn } from "./computerControls";
const EMPTY_GRANTS: ReadonlyArray<ComputerGrant> = [];
const HISTORY_LIMIT = 20;
const TONE_CLASS: Record<ComputerStatusTone, string> = {
  ok: "bg-success",
  pending: "bg-info animate-pulse",
  warning: "bg-warning",
  error: "bg-destructive",
  off: "bg-muted-foreground",
};
type AccessRequest = typeof ComputerAccessPush.Type & { settled?: boolean; allowed?: boolean };
const KIND_LABEL: Record<AccessRequest["kind"], string> = {
  apps: "Apps",
  "session-actions": "Session actions",
  "chrome-setup": "Browser setup",
};

export function AgentComputerLiveCard({ threadId }: { threadId: ThreadId }) {
  const activity = useAgentComputerActivityStore((state) => state.activity[threadId]);
  const capture = useAgentComputerActivityStore((state) => state.lastCapture[threadId]);
  const grants = useAgentComputerActivityStore((state) => state.grants[threadId] ?? EMPTY_GRANTS);
  const appNames = useAgentComputerActivityStore((state) => state.appNames);
  const requests = useAgentComputerActivityStore((state) => state.requests);
  const paused = useAgentComputerActivityStore((state) => state.paused[threadId]);
  const held = useAgentComputerActivityStore((state) => state.lease.threadId === threadId);
  const lastLeaseAt = useAgentComputerActivityStore((state) => state.lastLeaseAt[threadId]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const history = useMemo(
    () =>
      Object.values(requests)
        .filter((request): request is AccessRequest => request?.threadId === threadId)
        .slice(-HISTORY_LIMIT)
        .reverse(),
    [requests, threadId],
  );
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch(() => setError("Computer control could not be updated."));
  };
  const visible =
    paused || grants.length > 0 || isAgentComputerActive(activity, now, held, lastLeaseAt);
  if (!visible) {
    const latest = history[0];
    if (!latest) return null;
    return (
      <div
        className="mx-auto mt-2 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border bg-card px-3 py-1 text-muted-foreground text-xs shadow-xs"
        data-testid="computer-access-summary"
      >
        <MonitorIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Computer access · last request{" "}
          {!latest.settled ? "pending" : latest.allowed ? "allowed" : "denied"}
        </span>
        <ComputerAccessHistory history={history} />
      </div>
    );
  }
  const native = activity?.backend === "native";
  const tone = computerStatusTone(activity, { paused, held });
  return (
    <div
      className={cn(
        "mx-auto mt-2 flex w-full max-w-3xl items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-xs",
        paused && "border-warning/50",
      )}
      role="status"
      data-testid="computer-live-card"
    >
      {capture?.thumbnailDataUrl ? (
        <img
          src={capture.thumbnailDataUrl}
          alt="Last captured computer action"
          title={capture.appName ? `Last capture · ${capture.appName}` : "Last capture"}
          className="h-12 w-20 shrink-0 rounded border border-border object-cover object-top"
        />
      ) : (
        <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-border bg-muted">
          <MonitorIcon className="size-4 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-1.5 truncate font-medium" aria-live="polite">
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[tone])} />
          <span className="truncate">{describeComputerAction(activity, { paused, held })}</span>
          {activity?.appName && !paused ? (
            <span className="truncate font-normal text-muted-foreground">· {activity.appName}</span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {grants.length === 0 ? (
            <span className="text-muted-foreground text-xs">No apps allowed</span>
          ) : (
            grants.map((grant) => {
              const name = appNames[grant.appId] ?? grant.appId;
              return (
                <Badge key={grant.appId} variant="outline" className="gap-1 pr-0.5">
                  {name} · {COMPUTER_TIER_LABEL[grant.tier]}
                  <button
                    type="button"
                    aria-label={`Revoke ${name}`}
                    title={`Revoke ${name}`}
                    className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() =>
                      run(async () =>
                        readNativeApi()?.computer?.access.revoke({ threadId, appId: grant.appId }),
                      )
                    }
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              );
            })
          )}
        </div>
        {error ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {error}
          </p>
        ) : null}
      </div>
      {history.length > 0 ? <ComputerAccessHistory history={history} /> : null}
      <Button
        size="xs"
        variant="outline"
        onClick={() => run(() => pauseComputerThread(threadId, !paused))}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button
        size="xs"
        variant="destructive"
        title={native ? "Stop computer input" : "Stops after the current action"}
        onClick={() => run(() => stopComputerTurn(threadId))}
      >
        <SquareIcon />
        Stop
      </Button>
    </div>
  );
}

function ComputerAccessHistory({ history }: { history: ReadonlyArray<AccessRequest> }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost">
            <HistoryIcon />
            History ({history.length})
          </Button>
        }
      />
      <PopoverPopup className="w-96" align="end">
        <PopoverTitle className="mb-2 text-sm">Access requests</PopoverTitle>
        <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="computer-access-history">
          {history.map((request) => (
            <li key={request.requestId} className="flex gap-2 rounded-md px-1 py-1.5 text-sm">
              {!request.settled ? (
                <ClockIcon
                  aria-label="Pending"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
              ) : request.allowed ? (
                <CheckIcon aria-label="Allowed" className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : (
                <XIcon
                  aria-label="Denied"
                  className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {request.apps.length > 0
                    ? request.apps
                        .map((app) => `${app.name} · ${COMPUTER_TIER_LABEL[app.tier]}`)
                        .join(", ")
                    : KIND_LABEL[request.kind]}
                </p>
                {request.reason ? (
                  <p className="line-clamp-2 text-muted-foreground text-xs">{request.reason}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
