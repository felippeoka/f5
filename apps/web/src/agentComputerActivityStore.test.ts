import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentComputerActive, useAgentComputerActivityStore } from "./agentComputerActivityStore";
import { computerUseBannerTargets, computerUseBannerText } from "./components/ComputerUseBanner";
const threadId = ThreadId.makeUnsafe("computer-thread");
beforeEach(() =>
  useAgentComputerActivityStore.setState({
    appNames: {},
    activity: {},
    lastCapture: {},
    grants: {},
    requests: {},
    paused: {},
    leases: { holders: [] },
    lastLeaseAt: {},
  }),
);
describe("computer activity", () => {
  it("keeps the last capture separate from later actions that have no screenshot", () => {
    const store = useAgentComputerActivityStore.getState();
    store.record({
      threadId,
      op: "activateApp",
      status: "completed",
      backend: "native",
      appName: "Fixture",
      thumbnailDataUrl: "SYNTHETIC_CAPTURE",
    });
    store.record({ threadId, op: "type", status: "started", backend: "native" });
    store.record({ threadId, op: "type", status: "completed", backend: "native" });
    const state = useAgentComputerActivityStore.getState();
    expect(state.activity[threadId]).toMatchObject({ op: "type", status: "completed" });
    expect(state.activity[threadId]?.thumbnailDataUrl).toBeUndefined();
    expect(state.lastCapture[threadId]).toMatchObject({
      op: "activateApp",
      appName: "Fixture",
      thumbnailDataUrl: "SYNTHETIC_CAPTURE",
    });
    expect(state.lastCapture.otherThread).toBeUndefined();
  });
  it("discards capture content on grant changes, backend switches and reconnect", () => {
    const store = useAgentComputerActivityStore.getState();
    const captured = {
      threadId,
      op: "click",
      status: "completed" as const,
      backend: "native" as const,
      thumbnailDataUrl: "SYNTHETIC_CAPTURE",
    };
    store.record(captured);
    store.setGrants(threadId, []);
    expect(useAgentComputerActivityStore.getState().lastCapture[threadId]).toBeUndefined();
    expect(JSON.stringify(useAgentComputerActivityStore.getState())).not.toContain(
      "SYNTHETIC_CAPTURE",
    );
    store.record(captured);
    store.record({ threadId, op: "computer", status: "started", backend: "codex-builtin" });
    expect(useAgentComputerActivityStore.getState().lastCapture[threadId]).toBeUndefined();
    store.record(captured);
    store.resetConnection();
    expect(useAgentComputerActivityStore.getState().lastCapture).toEqual({});
  });
  it("keeps controls visible for 15 seconds after lease release even when the last action is older", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
    try {
      const store = useAgentComputerActivityStore.getState();
      store.record({ threadId, op: "type", status: "completed", backend: "native" });
      store.setLeases({
        holders: [{ threadId, backend: "native", delivery: "foreground", state: "active" }],
      });
      clock.mockReturnValue(130000);
      store.setLeases({ holders: [] });
      const state = useAgentComputerActivityStore.getState();
      expect(state.lastLeaseAt[threadId]).toBe(130000);
      expect(
        isAgentComputerActive(state.activity[threadId], 144999, false, state.lastLeaseAt[threadId]),
      ).toBe(true);
      expect(
        isAgentComputerActive(state.activity[threadId], 145000, false, state.lastLeaseAt[threadId]),
      ).toBe(false);
      store.resetConnection();
      expect(useAgentComputerActivityStore.getState().lastLeaseAt).toEqual({});
    } finally {
      clock.mockRestore();
    }
  });
  it("keeps running actions and held leases visible, then expires completed feedback", () => {
    const store = useAgentComputerActivityStore.getState();
    store.record({ threadId, op: "click", status: "started", backend: "native" });
    let activity = useAgentComputerActivityStore.getState().activity[threadId]!;
    expect(isAgentComputerActive(activity, activity.at + 60000, false)).toBe(true);
    store.record({ threadId, op: "click", status: "completed", backend: "native" });
    activity = useAgentComputerActivityStore.getState().activity[threadId]!;
    expect(isAgentComputerActive(activity, activity.at + 14999, false)).toBe(true);
    expect(isAgentComputerActive(activity, activity.at + 15000, false)).toBe(false);
    expect(isAgentComputerActive(activity, activity.at + 60000, true)).toBe(true);
  });
  it("discards missed consent settlements before replaying a reconnect snapshot", () => {
    const store = useAgentComputerActivityStore.getState();
    store.request({
      requestId: "expired",
      threadId,
      backendIncarnation: "old",
      kind: "apps",
      reason: "Old",
      apps: [],
    });
    store.setPaused(threadId, true);
    store.resetConnection();
    store.request({
      requestId: "current",
      threadId,
      backendIncarnation: "new",
      kind: "apps",
      reason: "New",
      apps: [],
    });
    store.settle({ requestId: "expired", threadId, allowed: true });
    expect(Object.keys(useAgentComputerActivityStore.getState().requests)).toEqual(["current"]);
    expect(useAgentComputerActivityStore.getState().requests.current?.settled).toBeUndefined();
    expect(useAgentComputerActivityStore.getState().paused[threadId]).toBeUndefined();
    store.resetConnection();
    expect(useAgentComputerActivityStore.getState().requests).toEqual({});
  });
  it("settles cards without accepting unknown requests and preserves pause state", () => {
    const store = useAgentComputerActivityStore.getState();
    store.request({
      requestId: "r",
      threadId,
      backendIncarnation: "b",
      kind: "apps",
      reason: "Edit",
      apps: [],
    });
    store.settle({ requestId: "missing", threadId, allowed: true });
    store.settle({ requestId: "r", threadId, allowed: false });
    store.setPaused(threadId, true);
    expect(useAgentComputerActivityStore.getState().requests.r).toMatchObject({
      settled: true,
      allowed: false,
    });
    expect(useAgentComputerActivityStore.getState().requests.missing).toBeUndefined();
    expect(useAgentComputerActivityStore.getState().paused[threadId]).toBe(true);
  });
  it("tracks several holders and stamps only the removed ones", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(5000);
    try {
      const other = ThreadId.makeUnsafe("other-thread");
      const store = useAgentComputerActivityStore.getState();
      store.setLeases({
        holders: [
          {
            threadId,
            backend: "native",
            delivery: "background",
            appId: "com.apple.TextEdit",
            appName: "TextEdit",
            state: "active",
          },
          { threadId: other, backend: "native", delivery: "background", state: "active" },
        ],
      });
      expect(useAgentComputerActivityStore.getState().appNames["com.apple.TextEdit"]).toBe(
        "TextEdit",
      );
      store.setLeases({
        holders: [{ threadId: other, backend: "native", delivery: "background", state: "active" }],
      });
      expect(useAgentComputerActivityStore.getState().lastLeaseAt).toEqual({ [threadId]: 5000 });
    } finally {
      clock.mockRestore();
    }
  });
});
describe("computer use banner text", () => {
  const holder = {
    threadId,
    backend: "native" as const,
    delivery: "background" as const,
    appId: "com.apple.TextEdit",
    appName: "TextEdit",
    state: "active" as const,
  };
  it("names the app for background control and counts several agents", () => {
    expect(computerUseBannerText({ holders: [holder] }, false)).toBe(
      "An agent is working in TextEdit in the background",
    );
    expect(
      computerUseBannerText(
        {
          holders: [
            holder,
            { ...holder, threadId: ThreadId.makeUnsafe("b"), appId: "n", appName: "Notes" },
          ],
        },
        false,
      ),
    ).toBe("2 agents are working in the background in TextEdit, Notes");
    expect(
      computerUseBannerTargets({
        holders: [holder, { ...holder, threadId: ThreadId.makeUnsafe("b") }],
      }),
    ).toEqual([threadId, "b"]);
  });
  it("prefers foreground control, pending takeover and explains pauses", () => {
    expect(
      computerUseBannerText(
        { holders: [holder, { ...holder, delivery: "foreground", appId: undefined }] },
        false,
      ),
    ).toBe("An agent is controlling this computer");
    expect(
      computerUseBannerText(
        {
          holders: [holder],
          pendingTakeover: { threadId, appId: "x", appName: "Notes", state: "waiting-idle" },
        },
        false,
      ),
    ).toBe("An agent will take over Notes when you stop using the mouse and keyboard");
    expect(
      computerUseBannerText(
        { holders: [{ ...holder, state: "paused", pauseCause: "target-active" }] },
        false,
      ),
    ).toBe("Computer control paused · you are using that app");
    expect(
      computerUseBannerText(
        { holders: [{ ...holder, state: "recovery", pauseCause: "outcome-unknown" }] },
        false,
      ),
    ).toBe(
      "Computer control stopped · check TextEdit before resuming · last action's result is unknown",
    );
    expect(computerUseBannerText({ holders: [], otherProfile: true }, false)).toBe(
      "An agent in another F5 profile is controlling this computer",
    );
    expect(computerUseBannerText({ holders: [] }, false)).toBeNull();
  });
});
