import { Schema } from "effect";
import {
  ComputerAutomationError,
  ComputerInspectResult,
  ComputerScreenshot,
  ComputerApp,
  DesktopComputerHostMessage,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";
import { RehearsalResponses } from "./rehearsalResponses";

/** Development-only IPC observer. Never changes messages or keeps raw tool I/O. */
export class ElectronRehearsalObservation {
  private readonly responses = new RehearsalResponses();
  private readonly admitted = new Set<string>();
  private readonly pending = new Map<string, ComputerAutomationRequest["op"] | "leaseAcquire">();
  private readonly operations: Array<Record<string, string | number | boolean>> = [];
  private held = false;
  private leaseObserved = false;
  private pauseObserved = false;
  private resumeObserved = false;
  private captureResponses = 0;
  private inspectionResponses = 0;
  private overflow = false;
  private readonly accessRequests = new Set<string>();
  private readonly accessAnswers = new Set<string>();
  private hostStatus: { available: boolean; reason?: string } | undefined;
  receive(raw: unknown): void {
    if (!Schema.is(DesktopComputerHostMessage)(raw)) return;
    if (raw.type === "status") {
      this.hostStatus = raw.status.available
        ? { available: true }
        : { available: false, reason: raw.status.reason };
    } else if (raw.type === "accessRequested") {
      if (this.accessRequests.size >= 128) this.overflow = true;
      else this.accessRequests.add(raw.request.requestId);
    } else if (raw.type === "accessAnswer") {
      if (this.accessRequests.has(raw.answer.requestId))
        this.accessAnswers.add(raw.answer.requestId);
    } else if (raw.type === "request" || raw.type === "leaseAcquire") {
      const requestId = raw.type === "request" ? raw.request.requestId : raw.requestId;
      if (this.admitted.has(requestId)) return;
      if (this.admitted.size >= 128) {
        this.overflow = true;
        return;
      }
      this.admitted.add(requestId);
      this.pending.set(requestId, raw.type === "request" ? raw.request.op : "leaseAcquire");
      if (raw.type === "request") this.responses.request(raw.request);
    } else if (raw.type === "response") {
      const op = this.pending.get(raw.requestId);
      if (!op) return;
      this.pending.delete(raw.requestId);
      this.responses.response(raw);
      const summary: Record<string, string | number | boolean> = { op, outcome: "ok" };
      if (raw.error !== undefined) {
        if (Schema.is(ComputerAutomationError)(raw.error)) {
          const error = raw.error;
          summary.outcome = error._tag;
          if (error._tag === "Unavailable") summary.reason = error.reason;
          if (error._tag === "Interrupted") summary.cause = error.cause;
          if (error._tag === "TargetBlocked") summary.kind = error.kind;
          if (error._tag === "NotGranted") summary.needed = error.needed;
        } else summary.outcome = "invalid-error";
      } else if (op === "listApps") {
        const valid = Schema.is(Schema.Array(ComputerApp))(raw.result);
        summary.validApps = valid;
        if (!valid) summary.outcome = "invalid-apps";
      } else if (op === "screenshot") {
        const valid = Schema.is(ComputerScreenshot)(raw.result) && raw.result.data.length > 0;
        summary.validCapture = valid;
        if (valid) this.captureResponses++;
      } else if (op === "inspect") {
        const valid = Schema.is(ComputerInspectResult)(raw.result);
        if (valid) {
          summary.accessible = raw.result.accessible;
          summary.nodes = raw.result.nodes.length;
          if (raw.result.accessible && raw.result.nodes.length > 0) this.inspectionResponses++;
        } else summary.outcome = "invalid-inspection";
      }
      this.operations.push(summary);
    } else if (raw.type === "leaseChanged") {
      this.held = raw.holder !== null;
      this.leaseObserved ||= this.held;
    } else if (raw.type === "pauseChanged") {
      if (raw.paused) this.pauseObserved = true;
      else this.resumeObserved = true;
    }
  }
  snapshot() {
    return {
      responses: this.responses.checks(),
      hostStatus: this.hostStatus,
      held: this.held,
      leaseObserved: this.leaseObserved,
      pauseObserved: this.pauseObserved,
      resumeObserved: this.resumeObserved,
      captureResponses: this.captureResponses,
      inspectionResponses: this.inspectionResponses,
      traceComplete: !this.overflow,
      accessRequests: this.accessRequests.size,
      accessAnswersForwarded: this.accessAnswers.size,
      operations: this.operations.map((operation) => ({ ...operation })),
    };
  }
}

/** Already-sanitized provider activities can contain pre-host tool failures. Keep
 * only known error tags, never their detail strings or arbitrary provider fields. */
export function rehearsalProviderErrorCodes(activities: unknown): string[] {
  const codes = new Set<string>();
  const known = new Set([
    "Unavailable",
    "Busy",
    "Interrupted",
    "OutcomeUnknown",
    "NotGranted",
    "TargetBlocked",
    "GeometryChanged",
    "StaleElement",
    "UnsupportedAction",
    "ReplayRejected",
    "PayloadMismatch",
    "ResultTooLarge",
    "Execution",
  ]);
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (++visited > 2000 || depth > 12 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const value = node as Record<string, unknown>;
    if (typeof value._tag === "string" && known.has(value._tag)) codes.add(value._tag);
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(activities, 0);
  return [...codes].sort();
}
