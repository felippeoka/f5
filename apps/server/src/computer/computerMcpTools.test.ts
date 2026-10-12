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
function setup(displays = [display]) {
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
    reportToolFailure: vi.fn(),
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
  it("installs one catalog of fifteen tools, with only discovery tools always loaded", () => {
    expect(COMPUTER_TOOL_DEFINITIONS).toHaveLength(15);
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
    );
    h.context.geometry.clear();
    expect((await callComputerTool(h.context, "computer_move", { x: 3, y: 4 })).isError).toBe(true);
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
