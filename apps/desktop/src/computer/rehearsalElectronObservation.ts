import { Schema } from "effect";
import {
  ComputerAutomationError,
  ComputerInspectResult,
  ComputerScreenshot,
  ComputerApp,
  ComputerActionResult,
  DesktopComputerHostMessage,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";
import { RehearsalResponses, rehearsalExecutionCode } from "./rehearsalResponses";

/** Development-only IPC observer. Never changes messages or keeps raw tool I/O. */
export class ElectronRehearsalObservation {
  private readonly responses = new RehearsalResponses();
  private readonly admitted = new Set<string>();
  private readonly pending = new Map<string, ComputerAutomationRequest["op"] | "leaseAcquire">();
  private readonly elementActions = new Map<string, string>();
  private readonly operations: Array<Record<string, string | number | boolean>> = [];
  private held = false;
  private leaseObserved = false;
  private pauseObserved = false;
  private resumeObserved = false;
  private captureResponses = 0;
  private inspectionResponses = 0;
  private activityMessages = 0;
  private activityThumbnails = 0;
  private readonly toolOutcomeErrors = new Set<string>();
  private overflow = false;
  private readonly accessRequests = new Set<string>();
  private readonly accessAnswers = new Set<string>();
  private readonly accessKinds = new Map<string, string>();
  private readonly accessAnswerSummaries: Array<{
    kind: string;
    appCount: number;
    allowed: number;
    remembered: number;
    allowSessionActions?: boolean;
  }> = [];
  private readonly sessions = new Set<string>();
  private grantChanges = 0;
  private lastGrantCount = 0;
  private hostStatus: { available: boolean; reason?: string } | undefined;
  receive(raw: unknown): void {
    if (!Schema.is(DesktopComputerHostMessage)(raw)) return;
    if (raw.type === "status") {
      this.hostStatus = raw.status.available
        ? { available: true }
        : { available: false, reason: raw.status.reason };
    } else if (raw.type === "activity") {
      this.activityMessages++;
      if (raw.activity.thumbnailDataUrl) this.activityThumbnails++;
      if (raw.activity.outcome) this.toolOutcomeErrors.add(raw.activity.outcome);
    } else if (raw.type === "accessRequested") {
      if (this.accessRequests.size >= 128) this.overflow = true;
      else {
        this.accessRequests.add(raw.request.requestId);
        this.accessKinds.set(raw.request.requestId, raw.request.kind);
      }
    } else if (raw.type === "accessAnswer") {
      if (
        this.accessRequests.has(raw.answer.requestId) &&
        !this.accessAnswers.has(raw.answer.requestId)
      ) {
        this.accessAnswers.add(raw.answer.requestId);
        this.accessAnswerSummaries.push({
          kind: this.accessKinds.get(raw.answer.requestId)!,
          appCount: raw.answer.decisions.length,
          allowed: raw.answer.decisions.filter((decision) => decision.allow).length,
          remembered: raw.answer.decisions.filter((decision) => decision.allow && decision.remember)
            .length,
          ...(this.accessKinds.get(raw.answer.requestId) === "session-actions"
            ? { allowSessionActions: raw.answer.allowSessionActions === true }
            : {}),
        });
      }
    } else if (raw.type === "grantsChanged") {
      this.grantChanges++;
      this.lastGrantCount = raw.authorization.grants.length;
    } else if (raw.type === "request" || raw.type === "leaseAcquire") {
      const requestId = raw.type === "request" ? raw.request.requestId : raw.requestId;
      if (this.admitted.has(requestId)) return;
      if (this.admitted.size >= 128) {
        this.overflow = true;
        return;
      }
      this.admitted.add(requestId);
      this.pending.set(requestId, raw.type === "request" ? raw.request.op : "leaseAcquire");
      if (raw.type === "request") {
        this.responses.request(raw.request);
        this.sessions.add(raw.request.authorization.sessionGeneration);
      }
      if (raw.type === "request" && raw.request.op === "elementAction")
        this.elementActions.set(requestId, raw.request.action);
    } else if (raw.type === "response") {
      const op = this.pending.get(raw.requestId);
      if (!op) return;
      this.pending.delete(raw.requestId);
      this.responses.response(raw);
      const summary: Record<string, string | number | boolean> = { op, outcome: "ok" };
      const action = this.elementActions.get(raw.requestId);
      if (action) {
        summary.action = action;
        this.elementActions.delete(raw.requestId);
      }
      if (raw.error !== undefined) {
        if (Schema.is(ComputerAutomationError)(raw.error)) {
          const error = raw.error;
          summary.outcome = error._tag;
          if (error._tag === "Unavailable") summary.reason = error.reason;
          if (error._tag === "Interrupted") summary.cause = error.cause;
          if (error._tag === "TargetBlocked") summary.kind = error.kind;
          if (error._tag === "NotGranted") summary.needed = error.needed;
          if (error._tag === "Execution") {
            const code = rehearsalExecutionCode(error.message);
            if (code) summary.executionCode = code;
          }
        } else summary.outcome = "invalid-error";
      } else if (op === "activateApp" || op === "openApp") {
        if (raw.result && typeof raw.result === "object") {
          const action = raw.result as Record<string, unknown>;
          summary.actionCompleted = action.actionCompleted === true;
          summary.actionCaptureSucceeded =
            Schema.is(ComputerScreenshot)(action.screenshot) && action.screenshot.data.length > 0;
          const error = action.screenshotError;
          if (typeof error === "string" && rehearsalProviderErrorCodes([{ _tag: error }]).length)
            summary.screenshotError = error;
        }
      } else if (op === "type" || op === "elementAction") {
        if (!Schema.is(ComputerActionResult)(raw.result) || raw.result.actionCompleted === false)
          summary.outcome = "invalid-action";
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
      activityMessages: this.activityMessages,
      activityThumbnails: this.activityThumbnails,
      toolOutcomeErrors: [...this.toolOutcomeErrors].sort(),
      traceComplete: !this.overflow,
      pendingResponses: this.pending.size,
      accessRequests: this.accessRequests.size,
      accessAnswersForwarded: this.accessAnswers.size,
      accessAnswerSummaries: this.accessAnswerSummaries.map((summary) => ({ ...summary })),
      sessionGenerationsObserved: this.sessions.size,
      grantChanges: this.grantChanges,
      lastGrantCount: this.lastGrantCount,
      operations: this.operations.map((operation) => ({ ...operation })),
    };
  }
}

/** Diagnostic categories only, never raw session errors. These hints do not
 * participate in authorization or certify the underlying cause. */
export function rehearsalSessionErrorCode(error: unknown): string {
  if (typeof error !== "string" || !error.trim()) return "none";
  const text = error.slice(0, 8192);
  if (/usage limit|hit.*limit|quota|rate.?limit|credits/i.test(text)) return "usage-limit";
  if (/disabled in settings|provider.*not implemented|provider.*unavailable/i.test(text))
    return "provider-unavailable";
  if (/unsupported-isolation|profile.?isolation|certified Agent SDK/i.test(text))
    return "profile-isolation";
  if (/context.?guard|delivery.?guard/i.test(text)) return "context-guard";
  if (
    /failed to spawn|failed to launch|process exited|executable|ENOENT|EACCES|ReferenceError/i.test(
      text,
    )
  )
    return "cli-launch";
  if (/not logged in|authentication|unauthori[sz]ed|invalid (api key|credentials)/i.test(text))
    return "authentication";
  if (
    /unknown model|invalid model|model.{0,100}(not found|unsupported|unavailable|does not exist)/i.test(
      text,
    )
  )
    return "model-unavailable";
  if (/mcp server|tool schema|sdk mcp/i.test(text)) return "mcp";
  return "unknown";
}

/** Harness diagnostics are enums only. Playwright messages can contain DOM text,
 * tool content or paths and must never be retained in certification evidence. */
export function rehearsalHarnessFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message.slice(0, 8192);
  if (/strict mode violation/i.test(message)) return "ambiguous-locator";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (message === "Unexpected certification consent request.") return "unexpected-consent";
  if (message === "Unexpected certification consent answer.") return "unexpected-consent-answer";
  if (message === "Physical input interrupted the active turn.") return "physical-input";
  if (message === "Provider turn did not complete.") return "provider-turn-incomplete";
  if (/receipt incomplete\.$/.test(message)) return "incomplete-receipt";
  return "unknown";
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
