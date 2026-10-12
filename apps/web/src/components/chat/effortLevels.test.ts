import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  CURSOR_REASONING_OPTIONS,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";

import {
  getEffortChipClass,
  getEffortLevel,
  isEffortDescriptor,
  isEffortScale,
  sortEffortOptions,
} from "./effortLevels";

const toOptions = (ids: ReadonlyArray<string>) => ids.map((id) => ({ id, label: id }));

describe("effortLevels", () => {
  it("sorts highest effort first, including Cursor's max-before-xhigh order", () => {
    // Cursor lists `..., max, xhigh`; reversing that would put xhigh above max.
    expect(
      sortEffortOptions(toOptions(CURSOR_REASONING_OPTIONS)).map((option) => option.id),
    ).toEqual(["max", "xhigh", "high", "medium", "low"]);
    expect(
      sortEffortOptions(toOptions(CODEX_REASONING_EFFORT_OPTIONS)).map((option) => option.id),
    ).toEqual(["ultra", "max", "xhigh", "high", "medium", "low"]);
  });

  it("ranks ultrathink above every other Claude level", () => {
    expect(
      sortEffortOptions(toOptions(CLAUDE_CODE_EFFORT_OPTIONS)).map((option) => option.id),
    ).toEqual(["ultrathink", "max", "xhigh", "high", "medium", "low"]);
  });

  it("treats a scale with an unknown level as not an effort scale", () => {
    expect(isEffortScale(toOptions(["minimal", "low", "high"]))).toBe(false);
    expect(isEffortScale(toOptions(["low", "high"]))).toBe(true);
    expect(isEffortScale([])).toBe(false);
    expect(getEffortLevel("toString")).toBeNull();
  });

  it("defines a tag and classes for every known level", () => {
    for (const id of new Set([
      ...CODEX_REASONING_EFFORT_OPTIONS,
      ...CLAUDE_CODE_EFFORT_OPTIONS,
      ...CURSOR_REASONING_OPTIONS,
    ])) {
      const level = getEffortLevel(id);
      expect(level, id).not.toBeNull();
      expect(level?.tag).not.toBe("");
      expect(level?.segmentClass).not.toBe("");
      expect(level?.glowClass).not.toBe("");
      expect(level?.textClass).not.toBe("");
      expect(level?.chipClass).not.toBe("");
    }
  });

  it("recognizes effort descriptors by id and options, and tints from the current value", () => {
    const effort: ProviderOptionDescriptor = {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low", isDefault: true },
        { id: "high", label: "High" },
      ],
    };
    const contextWindow: ProviderOptionDescriptor = {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [{ id: "high", label: "High" }],
    };
    expect(isEffortDescriptor(effort)).toBe(true);
    expect(isEffortDescriptor(contextWindow)).toBe(false);
    expect(getEffortChipClass([contextWindow, effort])?.level).toBe("low");
    expect(getEffortChipClass([contextWindow, { ...effort, currentValue: "high" }])?.level).toBe(
      "high",
    );
    expect(getEffortChipClass([contextWindow])).toBeNull();
  });
});
