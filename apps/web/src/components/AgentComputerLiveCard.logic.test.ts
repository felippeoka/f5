import { describe, expect, it } from "vitest";

import {
  COMPUTER_TIER_LABEL,
  computerStatusTone,
  describeComputerAction,
} from "./AgentComputerLiveCard.logic";

const done = (op: string) => ({ op, status: "completed" as const });

describe("computer live card text", () => {
  it("maps every known operation to a verb", () => {
    expect(
      [
        "screenshot",
        "zoom",
        "inspect",
        "click",
        "move",
        "drag",
        "scroll",
        "type",
        "key",
        "elementAction",
        "openApp",
        "activateApp",
        "listApps",
        "resolveApps",
        "status",
      ].map((op) => describeComputerAction(done(op), {})),
    ).toEqual([
      "Taking a screenshot",
      "Zooming in",
      "Reading the screen",
      "Clicking",
      "Moving the pointer",
      "Dragging",
      "Scrolling",
      "Typing",
      "Pressing a key",
      "Using a control",
      "Opening app",
      "Switching app",
      "Listing apps",
      "Finding apps",
      "Checking status",
    ]);
  });

  it("humanizes unknown operations", () => {
    expect(describeComputerAction(done("captureWindowRegion"), {})).toBe("Capture window region");
  });

  it("adds a suffix for each status", () => {
    const text = (status: "started" | "completed" | "failed" | "interrupted") =>
      describeComputerAction({ op: "activateApp", status }, {});
    expect(text("started")).toBe("Switching app…");
    expect(text("completed")).toBe("Switching app");
    expect(text("failed")).toBe("Switching app failed");
    expect(text("interrupted")).toBe("Switching app was interrupted");
  });

  it("describes paused, held and idle states", () => {
    expect(describeComputerAction(done("click"), { paused: true })).toBe("You have control");
    expect(describeComputerAction(undefined, { held: true })).toBe(
      "Agent is controlling this computer",
    );
    expect(describeComputerAction(undefined, {})).toBe("Idle");
  });

  it("labels every tier", () => {
    expect(COMPUTER_TIER_LABEL).toEqual({
      view: "View only",
      click: "Click",
      full: "Full control",
      blocked: "Blocked",
    });
  });
});

describe("computer status tone", () => {
  it("picks a tone for each state", () => {
    expect(computerStatusTone(done("click"), { paused: true })).toBe("warning");
    expect(computerStatusTone({ op: "click", status: "failed" }, {})).toBe("error");
    expect(computerStatusTone({ op: "click", status: "interrupted" }, {})).toBe("warning");
    expect(computerStatusTone({ op: "click", status: "started" }, {})).toBe("pending");
    expect(computerStatusTone(undefined, { held: true })).toBe("pending");
    expect(computerStatusTone(done("click"), {})).toBe("ok");
    expect(computerStatusTone(undefined, {})).toBe("off");
  });
});
