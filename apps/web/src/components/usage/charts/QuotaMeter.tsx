import type { UsageQuotaSample } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { formatTimeUntil, formatUsageResumeTime } from "../../../lib/usageLimits";
import { projectQuota, type QuotaProjection } from "../../../lib/usageQuotaProjection";
import { cn } from "../../../lib/utils";

function durationLabel(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function forecastText(
  projection: QuotaProjection | null,
  resetsAt: string | null,
  now: number,
): string | null {
  if (!projection || !resetsAt) return null;
  // Includes the date when the hit is not today, so multi-day windows read clearly.
  if (projection.kind === "will-hit")
    return `At this pace: limit reached ~${formatUsageResumeTime(projection.at, new Date(now))} (${durationLabel(
      Date.parse(resetsAt) - Date.parse(projection.at),
    )} before reset)`;
  if (projection.kind === "under")
    return `At this pace: ~${Math.round(projection.percentAtReset)}% used at reset`;
  return null;
}

function Sparkline(props: {
  readonly samples: ReadonlyArray<UsageQuotaSample>;
  readonly resetsAt: string;
  readonly projection: QuotaProjection | null;
  readonly current: { readonly at: string; readonly usedPercent: number } | null;
}) {
  const start = Date.parse(props.samples[0]!.at);
  const end = Date.parse(props.resetsAt);
  if (!(end > start)) return null;
  const x = (at: number) => ((Math.min(end, Math.max(start, at)) - start) / (end - start)) * 100;
  const y = (percent: number) => 24 - (Math.min(100, Math.max(0, percent)) / 100) * 22 - 1;
  const points = props.samples.map(
    (sample) => `${x(Date.parse(sample.at))},${y(sample.usedPercent)}`,
  );
  const last = props.current ?? props.samples.at(-1)!;
  let projected: { at: number; percent: number } | null = null;
  if (props.projection?.kind === "will-hit")
    projected = { at: Date.parse(props.projection.at), percent: 100 };
  else if (props.projection?.kind === "under")
    projected = { at: end, percent: props.projection.percentAtReset };
  return (
    <svg
      aria-hidden="true"
      data-testid="quota-sparkline"
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className="h-6 w-full overflow-visible text-primary"
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {projected ? (
        <line
          x1={x(Date.parse(last.at))}
          y1={y(last.usedPercent)}
          x2={x(projected.at)}
          y2={y(projected.percent)}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          className="opacity-60"
        />
      ) : null}
    </svg>
  );
}

export function QuotaMeter(props: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  accessibleName: string;
  /** Snapshot time of `utilization`; enables forecasts. */
  observedAt?: string | null;
  history?: ReadonlyArray<UsageQuotaSample>;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const percent =
    props.utilization === null ? undefined : Math.min(100, Math.max(0, props.utilization));
  const remainingPercent = percent === undefined ? undefined : 100 - percent;
  const resetMs = props.resetsAt ? Date.parse(props.resetsAt) : NaN;
  const resetValid = Number.isFinite(resetMs);
  const resetPassed = resetValid && resetMs <= now;
  const countdown = props.resetsAt && resetValid ? formatTimeUntil(props.resetsAt, now) : null;
  const reset = !resetValid
    ? "Reset time unavailable"
    : resetPassed
      ? "Reset time passed; awaiting updated usage"
      : `Resets ${new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(resetMs))}${countdown ? ` · ${countdown}` : ""}`;
  const valueText =
    props.utilization === null ? "Unknown" : `${remainingPercent!.toFixed(0)}% remaining`;
  const history = props.history ?? [];
  const projection =
    props.observedAt && !resetPassed
      ? projectQuota({
          samples: history,
          current: { at: props.observedAt, usedPercent: props.utilization },
          resetsAt: props.resetsAt,
          now,
        })
      : null;
  const forecast = forecastText(projection, props.resetsAt, now);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{props.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {valueText}
          {props.utilization !== null && props.utilization > 100
            ? ` · over limit (${Math.round(props.utilization)}% used)`
            : ""}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={props.accessibleName}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent}
        aria-valuetext={valueText}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            (percent ?? 0) >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${remainingPercent ?? 0}%` }}
        />
      </div>
      {history.length >= 2 && props.resetsAt && resetValid && !resetPassed ? (
        <Sparkline
          samples={history}
          resetsAt={props.resetsAt}
          projection={projection}
          current={
            props.observedAt && props.utilization !== null
              ? { at: props.observedAt, usedPercent: props.utilization }
              : null
          }
        />
      ) : null}
      <p className="text-2xs text-muted-foreground">{reset}</p>
      {forecast ? (
        <p
          className={cn(
            "text-2xs",
            projection?.kind === "will-hit" ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {forecast}
        </p>
      ) : null}
    </div>
  );
}
