import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { latestNativeGoal, resolveNativeGoalMenuState } from "./nativeGoal";

const metadata = (payload: unknown, id = "a") =>
  ({ id, kind: "native.metadata", payload }) as OrchestrationThreadActivity;

describe("latestNativeGoal", () => {
  it("reads the latest goal and ignores unrelated metadata", () => {
    expect(
      latestNativeGoal([
        metadata({ nativeGoal: { objective: "Old", status: "complete" } }, "a"),
        metadata({ nativeGoal: { objective: "Ship", status: "active" } }, "b"),
        metadata({ nativeAttachment: { attachmentType: "image" } }, "c"),
      ]),
    ).toEqual({ objective: "Ship", status: "active" });
  });

  it("returns null once the goal is cleared", () => {
    expect(
      latestNativeGoal([
        metadata({ nativeGoal: { objective: "Ship", status: "active" } }, "a"),
        metadata({ nativeGoal: null }, "b"),
      ]),
    ).toBeNull();
  });

  it("rejects malformed goals instead of displaying 'null'", () => {
    expect(latestNativeGoal([metadata({ nativeGoal: { objective: null, status: "x" } })])).toBe(
      null,
    );
    expect(latestNativeGoal([metadata({ nativeGoal: { objective: "Ship" } })])).toBeNull();
    expect(latestNativeGoal([metadata({ nativeGoal: "Ship" })])).toBeNull();
    expect(latestNativeGoal([])).toBeNull();
  });
});

describe("resolveNativeGoalMenuState", () => {
  const settled = { objective: "Ship", status: "complete" };
  const base = { supported: true, goal: null, turnBusy: false, requestPending: false };

  it("hides goal actions when the session does not support them", () => {
    expect(resolveNativeGoalMenuState({ ...base, supported: false })).toBeNull();
  });

  it("enables starting a goal on an idle thread", () => {
    expect(resolveNativeGoalMenuState(base)).toEqual({
      hasGoal: false,
      active: false,
      disabled: false,
    });
  });

  it("offers clearing a settled goal", () => {
    expect(resolveNativeGoalMenuState({ ...base, goal: settled })).toEqual({
      hasGoal: true,
      active: false,
      disabled: false,
    });
  });

  it("disables goal actions while a goal is active, a turn is busy, or a request is in flight", () => {
    expect(
      resolveNativeGoalMenuState({ ...base, goal: { ...settled, status: "active" } }),
    ).toMatchObject({ active: true, disabled: true });
    expect(resolveNativeGoalMenuState({ ...base, turnBusy: true })?.disabled).toBe(true);
    expect(resolveNativeGoalMenuState({ ...base, requestPending: true })?.disabled).toBe(true);
  });
});
