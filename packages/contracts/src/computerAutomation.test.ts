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
      secureAudit: {
        searchEnabled: true,
        elapsedMs: 1000,
        windows: [
          {
            windowIndex: 0,
            complete: false,
            elapsedMs: 1000,
            visitedNodes: 98,
            nodeReadElapsedMs: 990,
            maxChildren: 50050,
            textFieldQueries: 1,
            frameQueries: 0,
            searchResults: 0,
            searchElapsedMs: 5,
            searchFallbacks: 1,
            invalidSearchResults: 0,
            stopReasons: ["deadline"],
            axFailures: [{ operation: "text-fields", error: -25205, count: 1 }],
          },
        ],
      },
    };
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(value)).toEqual(value);
    const { secureAudit: _, ...legacy } = value;
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(legacy)).toEqual(legacy);
    expect(() =>
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        secureAudit: { ...value.secureAudit, elapsedMs: -1 },
      }),
    ).toThrow();
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
