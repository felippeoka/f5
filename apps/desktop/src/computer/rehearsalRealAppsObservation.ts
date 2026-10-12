import { Schema } from "effect";
import { isComputerMutation } from "@t3tools/shared/computerControl";
import {
  ComputerActionResult,
  ComputerInspectResult,
  DesktopComputerHostMessage,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";

export const REAL_APP_REHEARSAL_IDS = ["com.apple.TextEdit", "com.apple.calculator"] as const;
type AppKind = "textEdit" | "calculator";
const appKind = (appId: string | undefined): AppKind | undefined =>
  appId === REAL_APP_REHEARSAL_IDS[0]
    ? "textEdit"
    : appId === REAL_APP_REHEARSAL_IDS[1]
      ? "calculator"
      : undefined;

/** Correlated real-app outcomes only. Never retains text, keys, accessibility
 * content, images, app names or arbitrary errors from the native channel. */
export class RehearsalRealAppsObservation {
  private readonly admitted = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      op: ComputerAutomationRequest["op"];
      app?: AppKind;
      explicitApp: boolean;
      press: boolean;
    }
  >();
  private textEditInspected = false;
  private calculatorInspected = false;
  private textEditTyping = false;
  private textEditKeys = 0;
  private calculatorOpened = false;
  private calculatorPresses = 0;
  private unexpectedAppInput = false;
  private overflow = false;
  constructor(private readonly threadId: string) {}
  receive(raw: unknown): void {
    if (!Schema.is(DesktopComputerHostMessage)(raw)) return;
    if (raw.type === "request" && raw.request.authorization.threadId === this.threadId) {
      const request = raw.request;
      if (this.admitted.has(request.requestId)) return;
      if (this.admitted.size >= 128) {
        this.overflow = true;
        return;
      }
      this.admitted.add(request.requestId);
      const app = "appId" in request ? appKind(request.appId) : undefined;
      this.pending.set(request.requestId, {
        op: request.op,
        ...(app ? { app } : {}),
        explicitApp: "appId" in request,
        press: request.op === "elementAction" && request.action === "press",
      });
    } else if (raw.type === "response") {
      const request = this.pending.get(raw.requestId);
      if (!request) return;
      this.pending.delete(raw.requestId);
      if (raw.error !== undefined) return;
      const result = raw.result;
      if (
        request.op === "inspect" &&
        Schema.is(ComputerInspectResult)(result) &&
        result.accessible &&
        result.nodes.length &&
        appKind(result.appId) === request.app
      ) {
        if (request.app === "textEdit") this.textEditInspected = true;
        if (request.app === "calculator") this.calculatorInspected = true;
      } else if (
        isComputerMutation(request.op) &&
        Schema.is(ComputerActionResult)(result) &&
        result.actionCompleted !== false
      ) {
        const app = appKind(result.frontmostApp?.appId);
        if (!app || (request.explicitApp && request.app !== app)) {
          this.unexpectedAppInput = true;
          return;
        }
        if (request.op === "type" && app === "textEdit") this.textEditTyping = true;
        if (request.op === "key" && app === "textEdit") this.textEditKeys++;
        if (request.op === "openApp" && app === "calculator") this.calculatorOpened = true;
        if (request.press && app === "calculator") this.calculatorPresses++;
      }
    }
  }
  snapshot() {
    return {
      textEditInspected: this.textEditInspected,
      calculatorInspected: this.calculatorInspected,
      textEditTyping: this.textEditTyping,
      textEditKeys: this.textEditKeys,
      calculatorOpened: this.calculatorOpened,
      calculatorPresses: this.calculatorPresses,
      unexpectedAppInput: this.unexpectedAppInput,
      traceComplete: !this.overflow,
    };
  }
}
