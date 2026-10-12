import { Schema } from "effect";
import {
  ComputerActionResult,
  ComputerInspectResult,
  ComputerScreenshot,
  type ComputerAutomationRequest,
  type DesktopComputerHostMessage,
} from "@t3tools/contracts";

/** Correlates terminal responses without retaining image, accessibility or input content. */
export class RehearsalResponses {
  private readonly pending = new Map<
    string,
    { op: ComputerAutomationRequest["op"]; appId?: string }
  >();
  private readonly successful = new Set<ComputerAutomationRequest["op"]>();
  private readonly settled = new Set<string>();
  request(request: ComputerAutomationRequest): void {
    if (!this.pending.has(request.requestId) && !this.settled.has(request.requestId))
      this.pending.set(request.requestId, {
        op: request.op,
        ...(request.op === "inspect" ? { appId: request.appId } : {}),
      });
  }
  response(message: DesktopComputerHostMessage): void {
    if (message.type !== "response") return;
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    this.settled.add(message.requestId);
    if (message.error !== undefined) return;
    const result = message.result;
    const valid =
      request.op === "screenshot"
        ? Schema.is(ComputerScreenshot)(result) && result.data.length > 0
        : request.op === "inspect"
          ? Schema.is(ComputerInspectResult)(result) &&
            result.appId === request.appId &&
            result.accessible &&
            result.nodes.length > 0
          : (request.op === "type" || request.op === "elementAction") &&
            Schema.is(ComputerActionResult)(result) &&
            result.actionCompleted !== false;
    if (valid) this.successful.add(request.op);
  }
  checks() {
    return {
      nativeCaptureSucceeded: this.successful.has("screenshot"),
      nativeInspectionSucceeded: this.successful.has("inspect"),
      nativeInputSucceeded: this.successful.has("type") && this.successful.has("elementAction"),
    };
  }
}
