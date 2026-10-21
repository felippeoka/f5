import { describe, expect, it } from "vitest";
import { confirmedSchedule, validateScheduledDraft, type PreviewState } from "./schedulePreview";
import type { ScheduledTaskConfiguration } from "@t3tools/contracts";
const preview = {
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  summary: "Weekdays at 9",
  nextFireTimes: ["2026-10-23T09:00:00Z"],
  oneShotAt: null,
};
describe("schedule confirmation", () => {
  it("does not save unpreviewed, loading or failed conversions", () => {
    const states: PreviewState[] = [
      { kind: "unpreviewed" },
      { kind: "loading", key: "a" },
      { kind: "error", key: "a", message: "failed" },
    ];
    for (const state of states) expect(confirmedSchedule(state, "a", true)).toBeNull();
  });
  it("requires explicit NL confirmation but accepts a shown cron/preset", () => {
    const state = { kind: "ready", key: "a", preview } as const;
    expect(confirmedSchedule(state, "a", true)).toBeNull();
    expect(confirmedSchedule(state, "a", false)).toBe(preview);
    expect(confirmedSchedule({ ...state, kind: "confirmed" }, "a", true)).toBe(preview);
  });
  it("invalidates changed inputs and stale responses", () => {
    expect(
      confirmedSchedule(
        { kind: "confirmed", key: "old-project-zone-input", preview },
        "new-project-zone-input",
        true,
      ),
    ).toBeNull();
  });
  it("requires a new preview after a one-shot expires", () => {
    expect(
      confirmedSchedule(
        { kind: "confirmed", key: "a", preview: { ...preview, oneShotAt: "2026-01-01T00:00:00Z" } },
        "a",
        true,
        Date.parse("2026-01-02"),
      ),
    ).toBeNull();
  });
  it("requires prompt, name, model and explicit workspace configuration", () => {
    const value = {
      name: "Check",
      prompt: "Run tests",
      modelSelection: { instanceId: "codex", model: "model" },
      workspace: { kind: "projectRoot" },
    } as ScheduledTaskConfiguration;
    expect(validateScheduledDraft(value)).toBeNull();
    for (const patch of [
      { name: "" },
      { prompt: "" },
      { prompt: "/plan" },
      { workspace: { kind: "worktree", baseBranch: "" } },
    ])
      expect(
        validateScheduledDraft({ ...value, ...patch } as ScheduledTaskConfiguration),
      ).toBeTruthy();
  });
});
