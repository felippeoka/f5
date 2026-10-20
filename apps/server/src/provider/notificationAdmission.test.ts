import { describe, expect, it, vi } from "vitest";
import { NotificationAdmission } from "./notificationAdmission.ts";

describe("notification admission", () => {
  it("reserves control entries under entry saturation and releases each lease once", () => {
    const queue = new NotificationAdmission({ entries: 2, bytes: 100, controls: 1 });
    const first = queue.reserve(10)!,
      second = queue.reserve(20)!;
    expect(queue.reserve(1)).toBeUndefined();
    const control = queue.reserve(30, true)!;
    expect(control).toBeTypeOf("function");
    expect(queue.reserve(1, true)).toBeUndefined();
    first();
    first();
    second();
    control();
    expect(queue.snapshot()).toEqual({ entries: 0, controls: 0, bytes: 0, oldestAgeMs: 0 });
  });
  it("admits one oversized valid frame alone without allowing a second allocation", () => {
    const queue = new NotificationAdmission({ entries: 2, bytes: 100, controls: 1 });
    const release = queue.reserve(1000)!;
    expect(release).toBeTypeOf("function");
    expect(queue.reserve(1)).toBeUndefined();
    const control = queue.reserve(1, true)!;
    expect(control).toBeTypeOf("function");
    control();
    release();
    expect(queue.reserve(50)).toBeTypeOf("function");
    expect(queue.reserve(51)).toBeUndefined();
    expect(queue.reserve(-1)).toBeUndefined();
    expect(queue.reserve(NaN)).toBeUndefined();
  });
  it("counts active preparation, not just queued callbacks, and tracks oldest age", () => {
    vi.useFakeTimers();
    try {
      const queue = new NotificationAdmission();
      const first = queue.reserve(10)!;
      vi.advanceTimersByTime(100);
      const second = queue.reserve(20)!;
      vi.advanceTimersByTime(100);
      expect(queue.snapshot()).toMatchObject({ entries: 2, bytes: 30, oldestAgeMs: 200 });
      first();
      expect(queue.snapshot().oldestAgeMs).toBe(100);
      second();
      expect(queue.snapshot().oldestAgeMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
