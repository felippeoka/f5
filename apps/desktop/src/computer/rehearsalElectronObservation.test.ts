import { expect, it } from "vitest";
import type { ComputerAutomationRequest } from "@t3tools/contracts";
import {
  ElectronRehearsalObservation,
  rehearsalProviderErrorCodes,
  rehearsalSessionErrorCode,
} from "./rehearsalElectronObservation";

const request = (
  op: "screenshot" | "inspect" | "type" | "listApps" | "activateApp",
  requestId: string = op,
) =>
  ({
    requestId,
    payloadHash: "a".repeat(64),
    deadlineAtMs: Date.now() + 30000,
    authorization: {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
    },
    agent: { provider: "codex", threadTitle: "PRIVATE_SENTINEL" },
    op,
    appId: "fixture",
    maxNodes: 25,
    text: "PRIVATE_SENTINEL",
  }) as ComputerAutomationRequest;
const screenshot = {
  displayId: "display",
  geometryGeneration: "geometry",
  modelSize: { width: 100, height: 100 },
  mimeType: "image/png",
  data: "PRIVATE_SENTINEL",
  hiddenContent: true,
};

it("counts IPC activity and action captures without retaining thumbnails or screenshot errors", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "activity",
    activity: {
      threadId: "PRIVATE_SENTINEL",
      backend: "native",
      op: "activateApp",
      status: "completed",
      outcome: "app-resolution-failed",
      appName: "PRIVATE_SENTINEL",
      thumbnailDataUrl: "PRIVATE_SENTINEL",
    },
  });
  for (const [id, error] of [
    ["known", "missing-permissions"],
    ["private", "PRIVATE_SENTINEL"],
    ["tag", "Unavailable"],
  ]) {
    observer.receive({ type: "request", request: request("activateApp", id) });
    observer.receive({
      type: "response",
      requestId: id,
      result: {
        actionCompleted: true,
        screenshot,
        screenshotError: error,
      },
    });
  }
  const snapshot = observer.snapshot();
  expect(snapshot.activityMessages).toBe(1);
  expect(snapshot.activityThumbnails).toBe(1);
  expect(snapshot.toolOutcomeErrors).toEqual(["app-resolution-failed"]);
  expect(snapshot.operations).toEqual([
    { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
    { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
    {
      op: "activateApp",
      outcome: "ok",
      actionCompleted: true,
      actionCaptureSucceeded: true,
      screenshotError: "Unavailable",
    },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SENTINEL");
});

it("classifies fixed F5 execution failures without retaining arbitrary error detail", () => {
  const observer = new ElectronRehearsalObservation();
  for (const [id, message] of [
    ["timeout", "Accessibility observation timed out."],
    ["private", "PRIVATE_SENTINEL"],
    ["lookalike", "Accessibility observation timed out. PRIVATE_SENTINEL"],
  ]) {
    observer.receive({ type: "request", request: request("inspect", id) });
    observer.receive({ type: "response", requestId: id, error: { _tag: "Execution", message } });
  }
  expect(observer.snapshot().operations).toEqual([
    { op: "inspect", outcome: "Execution", executionCode: "accessibility-timeout" },
    { op: "inspect", outcome: "Execution" },
    { op: "inspect", outcome: "Execution" },
  ]);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("validates metadata responses and omits app identities from the diagnostic", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({ type: "request", request: request("listApps") });
  observer.receive({
    type: "response",
    requestId: "listApps",
    result: [
      {
        appId: "PRIVATE_SENTINEL",
        name: "PRIVATE_SENTINEL",
        running: true,
        frontmost: false,
        tier: "full",
      },
    ],
  });
  observer.receive({ type: "request", request: request("listApps", "bad-apps") });
  observer.receive({ type: "response", requestId: "bad-apps", result: { ok: true } });
  expect(observer.snapshot().operations).toEqual([
    { op: "listApps", outcome: "ok", validApps: true },
    { op: "listApps", outcome: "invalid-apps", validApps: false },
  ]);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("retains only known host status reasons and pre-host provider error codes", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "status",
    status: { available: false, reason: "monitor-unhealthy", detail: "PRIVATE_SENTINEL" },
  });
  expect(observer.snapshot().hostStatus).toEqual({ available: false, reason: "monitor-unhealthy" });
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
  expect(
    rehearsalProviderErrorCodes([
      { payload: { result: { error: { _tag: "ReplayRejected", detail: "PRIVATE_SENTINEL" } } } },
      { _tag: "PRIVATE_SENTINEL" },
    ]),
  ).toEqual(["ReplayRejected"]);
});
it("reduces session failures to fixed categories without retaining their contents", () => {
  const examples = [
    ["usage limit reached PRIVATE_SENTINEL", "usage-limit"],
    ["provider unavailable PRIVATE_SENTINEL", "provider-unavailable"],
    ["unsupported-isolation: PRIVATE_SENTINEL", "profile-isolation"],
    ["delivery guard rejected PRIVATE_SENTINEL", "context-guard"],
    ["Failed to launch executable PRIVATE_SENTINEL", "cli-launch"],
    ["authentication required PRIVATE_SENTINEL", "authentication"],
    ["unknown model PRIVATE_SENTINEL", "model-unavailable"],
    ["SDK MCP server failed PRIVATE_SENTINEL", "mcp"],
    ["PRIVATE_SENTINEL", "unknown"],
  ];
  for (const [message, expected] of examples) {
    const code = rehearsalSessionErrorCode(message);
    expect(code).toBe(expected);
    expect(code).not.toContain("PRIVATE_SENTINEL");
  }
  for (const value of [null, undefined, {}, " "])
    expect(rehearsalSessionErrorCode(value)).toBe("none");
  expect(rehearsalSessionErrorCode("x".repeat(8192) + "unknown model")).toBe("unknown");
});

it("records correlated outcome codes without input, images, accessibility values or error details", () => {
  const observer = new ElectronRehearsalObservation();
  for (const op of ["type", "inspect", "screenshot"] as const)
    observer.receive({ type: "request", request: request(op) });
  observer.receive({
    type: "response",
    requestId: "type",
    error: { _tag: "Execution", message: "PRIVATE_SENTINEL" },
  });
  observer.receive({
    type: "response",
    requestId: "inspect",
    result: {
      snapshotId: "snapshot",
      appId: "fixture",
      accessible: true,
      nodes: [
        {
          elementRef: "element",
          role: "AXTextField",
          name: "PRIVATE_SENTINEL",
          value: "PRIVATE_SENTINEL",
          enabled: true,
          focused: true,
          actions: [],
        },
      ],
    },
  });
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  const summary = observer.snapshot();
  expect(summary.operations).toEqual([
    { op: "type", outcome: "Execution" },
    { op: "inspect", outcome: "ok", accessible: true, nodes: 1 },
    { op: "screenshot", outcome: "ok", validCapture: true },
  ]);
  expect(JSON.stringify(summary)).not.toContain("PRIVATE_SENTINEL");
  expect(summary.captureResponses).toBe(1);
  expect(summary.responses.nativeInputSucceeded).toBe(false);
});
it("ignores uncorrelated and repeated terminal responses, including retried IDs", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  observer.receive({ type: "request", request: request("screenshot") });
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  observer.receive({ type: "request", request: request("screenshot") });
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  expect(observer.snapshot().captureResponses).toBe(1);
  expect(observer.snapshot().operations).toHaveLength(1);
});
it("keeps only typed interruption/protection codes and bounds the trace", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({ type: "request", request: request("type") });
  observer.receive({
    type: "response",
    requestId: "type",
    error: { _tag: "Interrupted", cause: "user-input" },
  });
  expect(observer.snapshot().operations[0]).toEqual({
    op: "type",
    outcome: "Interrupted",
    cause: "user-input",
  });
  for (let index = 0; index < 129; index++)
    observer.receive({ type: "request", request: request("screenshot", `capture-${index}`) });
  expect(observer.snapshot().traceComplete).toBe(false);
  observer.receive({ type: "request", request: { op: "INVALID_PRIVATE_SENTINEL" } });
  expect(JSON.stringify(observer.snapshot())).not.toContain("INVALID_PRIVATE_SENTINEL");
});

it("distinguishes requested consent from correlated host-forwarded answers without retaining decisions", () => {
  const observer = new ElectronRehearsalObservation();
  const answer = {
    requestId: "access",
    backendIncarnation: "backend",
    decisions: [{ appId: "PRIVATE_SENTINEL", allow: true, allowTyping: false, remember: false }],
  };
  observer.receive({ type: "accessAnswer", answer });
  expect(observer.snapshot().accessAnswersForwarded).toBe(0);
  observer.receive({
    type: "accessRequested",
    request: {
      requestId: "access",
      threadId: "thread",
      reason: "PRIVATE_SENTINEL",
      kind: "apps",
      apps: [{ appId: "PRIVATE_SENTINEL", name: "PRIVATE_SENTINEL", tier: "full" }],
    },
  });
  observer.receive({ type: "accessAnswer", answer });
  observer.receive({ type: "accessAnswer", answer });
  expect(observer.snapshot().accessRequests).toBe(1);
  expect(observer.snapshot().accessAnswersForwarded).toBe(1);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("records lease admission failures separately from native action responses", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "leaseAcquire",
    requestId: "lease",
    holder: {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
      backend: "native",
      threadTitle: "PRIVATE_SENTINEL",
    },
  });
  observer.receive({
    type: "response",
    requestId: "lease",
    error: { _tag: "Interrupted", cause: "user-input" },
  });
  expect(observer.snapshot().operations).toEqual([
    { op: "leaseAcquire", outcome: "Interrupted", cause: "user-input" },
  ]);
  expect(observer.snapshot().responses.nativeInputSucceeded).toBe(false);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("correlates semantic action enums and retains missing responses without retaining values", () => {
  const observer = new ElectronRehearsalObservation();
  for (const action of ["press", "focus", "setValue"] as const) {
    observer.receive({
      type: "request",
      request: {
        ...request("type", action),
        op: "elementAction",
        appId: "fixture",
        snapshotId: "snapshot",
        elementRef: "element",
        action,
        value: "PRIVATE_SENTINEL",
      },
    });
  }
  expect(observer.snapshot().pendingResponses).toBe(3);
  for (const action of ["press", "focus"])
    observer.receive({
      type: "response",
      requestId: action,
      result: {
        displayId: "display",
        geometryGeneration: "geometry",
        frontmostApp: null,
        cursor: null,
      },
    });
  expect(observer.snapshot().operations).toEqual([
    { op: "elementAction", outcome: "ok", action: "press" },
    { op: "elementAction", outcome: "ok", action: "focus" },
  ]);
  expect(observer.snapshot().pendingResponses).toBe(1);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("rejects malformed or explicitly uncompleted native action receipts", () => {
  const observer = new ElectronRehearsalObservation();
  for (const [id, result] of [
    ["malformed", {}],
    [
      "uncompleted",
      {
        displayId: "display",
        geometryGeneration: "geometry",
        frontmostApp: null,
        cursor: null,
        actionCompleted: false,
      },
    ],
  ] as const) {
    observer.receive({ type: "request", request: request("type", id) });
    observer.receive({ type: "response", requestId: id, result });
  }
  expect(observer.snapshot().operations.map((op) => op.outcome)).toEqual([
    "invalid-action",
    "invalid-action",
  ]);
  expect(observer.snapshot().pendingResponses).toBe(0);
});

it("counts session and grant changes without retaining grant or session identities", () => {
  const observer = new ElectronRehearsalObservation();
  for (const id of ["PRIVATE_SESSION_ONE", "PRIVATE_SESSION_TWO"]) {
    const req = request("listApps", id);
    const authorization = {
      ...req.authorization,
      sessionGeneration: id,
      grants: id.endsWith("ONE")
        ? [{ appId: "PRIVATE_APP", tier: "full" as const, allowTyping: false }]
        : [],
    };
    observer.receive({ type: "request", request: { ...req, authorization } });
    observer.receive({ type: "response", requestId: id, result: [] });
    observer.receive({ type: "grantsChanged", authorization });
  }
  expect(observer.snapshot()).toMatchObject({
    sessionGenerationsObserved: 2,
    grantChanges: 2,
    lastGrantCount: 0,
  });
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_");
});
