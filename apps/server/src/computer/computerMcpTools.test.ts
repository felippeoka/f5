import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_TOOL_DEFINITIONS,
  callComputerTool,
  ComputerToolGeometry,
} from "./computerMcpTools";
import type { ComputerAutomationBrokerRuntime } from "./ComputerAutomationBroker";
const display = {
  displayId: "d",
  geometryGeneration: "g",
  primary: true,
  rotation: 0,
  nativeBounds: { x: 0, y: 0, width: 100, height: 100 },
  pixelSize: { width: 100, height: 100 },
  modelSize: { width: 100, height: 100 },
};
function setup(displays = [display], delivery: "foreground" | "background" = "foreground") {
  const invoke = vi.fn(
    async (_thread: string, _session: string, input: { op: string }): Promise<unknown> =>
      input.op === "screenshot"
        ? {
            displayId: "d",
            geometryGeneration: "g",
            modelSize: display.modelSize,
            mimeType: "image/jpeg",
            data: "aGVsbG8=",
            hiddenContent: true,
          }
        : {},
  );
  const broker = {
    invoke,
    host: { status: () => ({ available: true, displays }) },
    requestAccess: vi.fn(async () => ({})),
    requestForeground: vi.fn(async () => ({ foreground: true, appId: "one" })),
    classify: vi.fn(async () => delivery),
    access: { grants: () => [{ appId: "one", tier: "full" }] },
    reportToolFailure: vi.fn(),
    reportToolCompleted: vi.fn(),
    wait: vi.fn(async () => ({ waitedMs: 100, timedOut: true })),
  };
  return {
    invoke,
    broker,
    context: {
      broker: broker as unknown as ComputerAutomationBrokerRuntime,
      threadId: "t",
      sessionGeneration: "s",
      geometry: new ComputerToolGeometry(),
    },
  };
}
describe("shared computer tool catalog", () => {
  it("reports safe pre-dispatch failures without screen contents or invalid argument values", async () => {
    const h = setup();
    await callComputerTool(h.context, "computer_type", { text: { secret: "PRIVATE_SENTINEL" } });
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "type",
      "invalid-arguments",
    );
    expect(h.invoke).not.toHaveBeenCalled();
    h.invoke.mockResolvedValue([
      { appId: "one", name: "Fixture" },
      { appId: "two", name: "Fixture" },
    ]);
    await callComputerTool(h.context, "computer_element_action", {
      app: "Fixture",
      snapshotId: "snapshot",
      elementRef: "element",
      action: "press",
    });
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "elementAction",
      "app-resolution-failed",
    );
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.broker.reportToolFailure.mock.calls)).not.toContain("PRIVATE_SENTINEL");
    h.broker.reportToolFailure.mockImplementation(() => {
      throw new Error("UI unavailable");
    });
    const result = await callComputerTool(h.context, "computer_click", { x: 1, y: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { _tag: "Execution", message: "Take a computer_screenshot first." },
    });
  });
  it("routes an explicit typing upgrade to the shared grant gate", async () => {
    const h = setup();
    const response = await callComputerTool(h.context, "computer_request_access", {
      apps: ["Terminal"],
      reason: "Typing needed",
      typing: true,
    });
    expect(response.isError).toBeFalsy();
    expect(h.broker.requestAccess).toHaveBeenCalledWith(
      "t",
      "s",
      ["Terminal"],
      "Typing needed",
      true,
    );
  });
  it("preserves completed input when its post-action screenshot fails", async () => {
    const h = setup();
    h.invoke.mockResolvedValue({ actionCompleted: true, screenshotError: "Unavailable" });
    const result = await callComputerTool(h.context, "computer_key", { keys: "Enter" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      actionCompleted: true,
      screenshotError: "Unavailable",
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("documents down/right scroll directions consistently", () => {
    expect(
      COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.name === "computer_scroll")?.description,
    ).toContain("Positive deltaY scrolls down; positive deltaX scrolls right.");
  });
  it("installs one catalog of seventeen tools, with only discovery tools always loaded", () => {
    expect(COMPUTER_TOOL_DEFINITIONS).toHaveLength(17);
    expect(COMPUTER_TOOL_DEFINITIONS.map((tool) => tool.name)).toContain(
      "computer_request_foreground",
    );
    expect(
      COMPUTER_TOOL_DEFINITIONS.filter((tool) => tool.alwaysLoad).map((tool) => tool.name),
    ).toEqual(["computer_status", "computer_request_access"]);
  });
  it("requires fresh screenshot geometry, uses display screenshot pixels and clears on resume", async () => {
    const h = setup();
    expect((await callComputerTool(h.context, "computer_click", { x: 3, y: 4 })).isError).toBe(
      true,
    );
    expect(h.invoke).not.toHaveBeenCalled();
    const screenshot = await callComputerTool(h.context, "computer_screenshot", {});
    expect(screenshot.content).toContainEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: "aGVsbG8=",
    });
    expect(JSON.stringify(screenshot.structuredContent)).not.toContain("aGVsbG8=");
    await callComputerTool(h.context, "computer_click", { x: 3, y: 4 });
    expect(h.invoke).toHaveBeenLastCalledWith(
      "t",
      "s",
      expect.objectContaining({
        op: "click",
        displayId: "d",
        geometryGeneration: "g",
        screenshot: true,
      }),
      undefined,
      expect.objectContaining({ onDispatch: expect.any(Function) }),
    );
    h.context.geometry.clear();
    expect((await callComputerTool(h.context, "computer_move", { x: 3, y: 4 })).isError).toBe(true);
  });
  it("classifies background screenshots before display selection and keys them by app scope", async () => {
    const h = setup([display, { ...display, displayId: "other" }], "background");
    h.invoke.mockImplementation(async (_thread, _session, input) =>
      input.op === "screenshot"
        ? {
            displayId: "d",
            geometryGeneration: "g",
            modelSize: display.modelSize,
            mimeType: "image/jpeg",
            data: "aGVsbG8=",
            hiddenContent: true,
            captureScope: "app",
          }
        : [{ appId: "one", name: "Fixture" }],
    );
    const screenshot = await callComputerTool(h.context, "computer_screenshot", {
      app: "Fixture",
    });
    expect(screenshot.isError).toBeFalsy();
    expect(h.broker.classify).toHaveBeenCalledWith("t", "s", "screenshot", "one", {
      executionMode: undefined,
      action: undefined,
    });
    const call = h.invoke.mock.calls.find(([, , input]) => input.op === "screenshot")![2];
    expect(call).toMatchObject({ op: "screenshot", appId: "one" });
    expect(call).not.toHaveProperty("displayId");
    // An app-scoped capture never authorizes display coordinates.
    expect(() => h.context.geometry.generation("d")).toThrow("Take a computer_screenshot first.");
    // A later lookup of the same granted app resolves from the cache.
    await callComputerTool(h.context, "computer_zoom", {
      app: "Fixture",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(h.invoke.mock.calls.filter(([, , input]) => input.op === "resolveApps")).toHaveLength(1);
  });
  it("never treats an app-scoped capture as display evidence, even in foreground mode", async () => {
    const h = setup();
    h.invoke.mockImplementation(async (_thread, _session, input) =>
      input.op === "screenshot"
        ? {
            displayId: "d",
            geometryGeneration: "g",
            modelSize: display.modelSize,
            mimeType: "image/jpeg",
            data: "aGVsbG8=",
            hiddenContent: true,
            captureScope: "app",
          }
        : [{ appId: "one", name: "Fixture" }],
    );
    await callComputerTool(h.context, "computer_screenshot", { app: "Fixture" });
    expect((await callComputerTool(h.context, "computer_click", { x: 3, y: 4 })).isError).toBe(
      true,
    );
  });
  it("discards a screenshot that completes after an invalidation", async () => {
    const h = setup();
    let finish: (value: unknown) => void = () => {};
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = callComputerTool(h.context, "computer_screenshot", {});
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    // A takeover, pause or policy revision lands while the capture is in flight.
    h.context.geometry.clear();
    finish({
      displayId: "d",
      geometryGeneration: "g",
      modelSize: display.modelSize,
      mimeType: "image/jpeg",
      data: "aGVsbG8=",
      hiddenContent: true,
    });
    await pending;
    expect((await callComputerTool(h.context, "computer_click", { x: 3, y: 4 })).isError).toBe(
      true,
    );
  });
  it("requires an app for background observations and routes foreground requests", async () => {
    const h = setup([display], "background");
    const missing = await callComputerTool(h.context, "computer_screenshot", {});
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      error: { message: "Specify app: the app to act in." },
    });
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "screenshot",
      "app-required",
    );
    expect(h.invoke).not.toHaveBeenCalled();
    const foreground = await callComputerTool(h.context, "computer_request_foreground", {
      app: "Fixture",
      reason: "Needs a drag",
    });
    expect(foreground.isError).toBeFalsy();
    expect(h.broker.requestForeground).toHaveBeenCalledWith("t", "s", "Fixture", "Needs a drag");
  });
  it("requires a display on multi-monitor machines before the first capture", async () => {
    const h = setup([display, { ...display, displayId: "other" }]);
    expect((await callComputerTool(h.context, "computer_screenshot", {})).isError).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each([
    ["computer_type", { text: "x".repeat(10001) }],
    ["computer_click", { x: -1, y: 0 }],
    ["computer_key", { keys: "Enter", repeat: 21 }],
    ["computer_status", { execute: "raw native message" }],
    ["unknown_tool", {}],
  ])("never throws for invalid %s calls", async (tool, input) => {
    const h = setup();
    await expect(callComputerTool(h.context, tool, input)).resolves.toMatchObject({
      isError: true,
    });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

import {
  COMPUTER_GUIDANCE,
  COMPUTER_SAFETY_CLAUSE,
  classifyComputerTool,
} from "./computerMcpTools";
it("keeps guidance on discovery, safety on actions, and the serialized catalog below budget", () => {
  const baselineDescriptionCharacters = 16 * 1300; // Lower bound on the original repeated guidance alone.
  expect(
    COMPUTER_TOOL_DEFINITIONS.filter((tool) => tool.description.includes(COMPUTER_GUIDANCE)).map(
      (tool) => tool.name,
    ),
  ).toEqual(["computer_status"]);
  const length = JSON.stringify(COMPUTER_TOOL_DEFINITIONS.map((tool) => tool.description)).length;
  expect(length).toBeLessThanOrEqual(6000);
  expect(length).toBeLessThan(baselineDescriptionCharacters / 2);
  for (const tool of COMPUTER_TOOL_DEFINITIONS) {
    if (
      classifyComputerTool(tool.name) === "mutate" ||
      ["computer_screenshot", "computer_zoom", "computer_inspect", "computer_wait"].includes(
        tool.name,
      )
    )
      expect(tool.description).toContain(COMPUTER_SAFETY_CLAUSE);
  }
  expect(
    COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.name === "computer_wait")?.annotations,
  ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
});
it("merges wait metadata with the trailing image or capture failure and publishes exactly one history row", async () => {
  const h = setup();
  const result = await callComputerTool(h.context, "computer_wait", {
    screenshot: true,
    timeoutMs: 100,
  });
  expect(result.structuredContent).toMatchObject({ waitedMs: 100 });
  expect(result.content.some((block) => block.type === "image")).toBe(true);
  expect(h.broker.reportToolCompleted).toHaveBeenCalledExactlyOnceWith(
    "t",
    "s",
    "wait",
    undefined,
    undefined,
  );
  h.invoke.mockRejectedValue(new Error("capture-failed"));
  const failed = await callComputerTool(h.context, "computer_wait", { screenshot: true });
  expect(failed).toMatchObject({ isError: true, structuredContent: { waitedMs: 100 } });
  expect(h.broker.reportToolFailure).toHaveBeenCalledExactlyOnceWith("t", "s", "wait", "Execution");
  const invalid = await callComputerTool(h.context, "computer_wait", { role: "AXButton" });
  expect(invalid.isError).toBe(true);
});

it("records delivery per invocation and leaves a plain wait unbadged", async () => {
  const h = setup();
  h.context.geometry.rememberApps([
    { appId: "one", name: "Fixture", tier: "full", running: true, frontmost: true },
  ]);
  vi.spyOn(h.context.broker, "classify").mockImplementation(
    async (_thread, _generation, _op, _app, input) =>
      input.executionMode === "background" ? "background" : "foreground",
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatched!: () => void;
  const admitted = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  vi.spyOn(h.context.broker, "invoke").mockImplementation(
    async (_thread, _generation, input, _timeout, options) => {
      options?.onDispatch?.(input.executionMode === "background" ? "background" : "foreground");
      if (input.executionMode === "background") {
        dispatched();
        await held;
      }
      return {};
    },
  );
  const first = callComputerTool(h.context, "computer_type", {
    app: "one",
    text: "first",
    executionMode: "background",
  });
  await admitted;
  await callComputerTool(h.context, "computer_type", {
    app: "one",
    text: "second",
    executionMode: "foreground",
  });
  release();
  await first;
  await callComputerTool(h.context, "computer_wait", { timeoutMs: 100 });
  expect(h.broker.reportToolCompleted.mock.calls).toEqual([
    ["t", "s", "type", "Fixture", "foreground"],
    ["t", "s", "type", "Fixture", "background"],
    ["t", "s", "wait", undefined, undefined],
  ]);
});
