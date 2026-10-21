import { ScheduledTaskId, ScheduledTaskRunId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildThreadActionMenuItems,
  nativeThreadActionMenuItems,
} from "./useThreadActionController";

describe("buildThreadActionMenuItems", () => {
  it("adapts active thread actions to pin and snooze state", () => {
    const active = buildThreadActionMenuItems({
      thread: { archivedAt: null, titleRegeneration: null },
      pinned: false,
      snoozed: false,
    });
    expect(active.map((item) => item.id)).toEqual([
      "rename",
      "regenerate-title",
      "pin",
      "snooze-three-hours",
      "snooze-tomorrow",
      "snooze-next-week",
      "archive",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
      "delete",
    ]);

    const snoozed = buildThreadActionMenuItems({
      thread: { archivedAt: null, titleRegeneration: null },
      pinned: false,
      snoozed: true,
    });
    expect(snoozed.some((item) => item.id === "wake")).toBe(true);
    expect(snoozed.some((item) => item.id.startsWith("snooze-"))).toBe(false);
  });

  it("preserves unavailable actions as disabled in native menus", () => {
    const items = buildThreadActionMenuItems({
      thread: {
        archivedAt: "2026-08-15T00:00:00.000Z",
        titleRegeneration: {
          requestId: "command-1" as never,
          startedAt: "2026-08-15T00:00:00.000Z",
        },
      },
      pinned: false,
      snoozed: false,
    });
    expect(items.find((item) => item.id === "title-regeneration-pending")?.disabled).toBe(true);
    expect(items.some((item) => item.id === "unarchive")).toBe(true);
    expect(items.some((item) => item.id === "pin")).toBe(false);
    expect(nativeThreadActionMenuItems(items)).toContainEqual(
      expect.objectContaining({ disabled: true }),
    );
  });
});

describe("scheduled thread actions", () => {
  const thread = {
    archivedAt: null,
    titleRegeneration: null,
    scheduledOrigin: {
      taskId: ScheduledTaskId.makeUnsafe("task"),
      runId: ScheduledTaskRunId.makeUnsafe("run"),
    },
  };
  it("identifies the source independently of the thread title and offers direct editing", () => {
    const items = buildThreadActionMenuItems({
      thread,
      pinned: false,
      snoozed: false,
      schedule: { state: "available", name: "Daily check" },
    });
    expect(items.slice(0, 3)).toEqual([
      { id: "scheduled-origin", label: "Scheduled task: Daily check", disabled: true },
      { id: "edit-schedule", label: "Edit scheduled task…" },
      { id: "rename", label: "Rename thread", separatorBefore: true },
    ]);
    expect(nativeThreadActionMenuItems(items).slice(0, 3)).toEqual(items.slice(0, 3));
  });
  it("distinguishes removed schedules from failed lookups without offering invalid editing", () => {
    for (const [state, label] of [
      ["removed", "Scheduled task removed"],
      ["unavailable", "Scheduled task unavailable"],
    ] as const) {
      const items = buildThreadActionMenuItems({
        thread,
        pinned: false,
        snoozed: false,
        schedule: { state },
      });
      expect(items[0]).toEqual({ id: "scheduled-origin", label, disabled: true });
      expect(items.some((item) => item.id === "edit-schedule")).toBe(false);
      expect(items.some((item) => item.id === "rename")).toBe(true);
    }
  });
});
