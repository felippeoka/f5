import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ComputerAutomationError,
  ComputerInspectResult,
  ComputerScreenshot,
} from "./computerAutomation";

describe("computer observation and error metadata", () => {
  it("decodes partial inspect snapshots", () => {
    const value = { snapshotId: "s", appId: "a", accessible: true, truncated: true, nodes: [] };
    expect(Schema.decodeUnknownSync(ComputerInspectResult)(value)).toEqual(value);
  });
  it("decodes screenshot mask scope and reasons", () => {
    const value = {
      displayId: "d",
      geometryGeneration: "g",
      modelSize: { width: 100, height: 100 },
      mimeType: "image/jpeg",
      data: "",
      hiddenContent: true,
      masked: "web-area",
      maskReasons: ["partial-audit", "window-match", "audit-incomplete", "windows-changed"],
    };
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(value)).toEqual(value);
  });
  it("accepts stale refs from legacy helpers and detailed macOS reasons", () => {
    for (const reason of [
      undefined,
      "snapshot-expired",
      "window-changed",
      "element-gone",
      "role-changed",
    ]) {
      const value = { _tag: "StaleElement", ...(reason ? { reason } : {}) };
      expect(Schema.decodeUnknownSync(ComputerAutomationError)(value)).toEqual(value);
    }
    expect(() =>
      Schema.decodeUnknownSync(ComputerAutomationError)({
        _tag: "StaleElement",
        reason: "unexpected",
      }),
    ).toThrow();
  });
});
