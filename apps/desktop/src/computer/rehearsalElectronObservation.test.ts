import { expect, it } from "vitest";
import type { ComputerAutomationRequest } from "@t3tools/contracts";
import {
  ElectronRehearsalObservation,
  rehearsalProviderErrorCodes,
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
