import { expect, it, vi } from "vitest";

import { createDeferredNavigationStopper, gateMainFrameRequests } from "./previewNavigationGuard";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fakeContents(id: number, session: unknown = fakeSession()) {
  const listeners = new Map<string, () => void>();
  return {
    id,
    session,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    stop: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    off: vi.fn((event: string) => listeners.delete(event)),
    emit: (event: string) => listeners.get(event)?.(),
  };
}

function fakeSession() {
  let gate: any;
  const onBeforeRequest = vi.fn((_filter, listener) => (gate = listener));
  const cancelled = (url: string, webContentsId?: number) => {
    let cancel: boolean | undefined;
    gate({ url, webContentsId }, (response: { cancel: boolean }) => (cancel = response.cancel));
    return cancel;
  };
  return { webRequest: { onBeforeRequest }, cancelled };
}

it("stops the current navigation on the next turn, not inside the listener", async () => {
  const contents = fakeContents(1);
  const stopper = createDeferredNavigationStopper(contents as never);
  stopper.navigationStarted();
  stopper.stopCurrentNavigation();
  expect(contents.stop).not.toHaveBeenCalled();
  await nextTurn();
  expect(contents.stop).toHaveBeenCalledTimes(1);
});

it("drops the stop when a newer navigation started first", async () => {
  const contents = fakeContents(1);
  const stopper = createDeferredNavigationStopper(contents as never);
  stopper.navigationStarted();
  stopper.stopCurrentNavigation();
  stopper.navigationStarted();
  await nextTurn();
  expect(contents.stop).not.toHaveBeenCalled();
});

it("drops the stop when the contents was destroyed first", async () => {
  const contents = fakeContents(1);
  const stopper = createDeferredNavigationStopper(contents as never);
  stopper.navigationStarted();
  stopper.stopCurrentNavigation();
  contents.destroyed = true;
  await nextTurn();
  expect(contents.stop).not.toHaveBeenCalled();
});

it("cancels only refused main-frame requests from gated contents", () => {
  const session = fakeSession();
  const gated = fakeContents(10, session);
  const other = fakeContents(11, session);
  gateMainFrameRequests(gated as never, (url) => url.startsWith("https://blocked.test"));
  gateMainFrameRequests(other as never, () => false);

  expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
  expect(session.webRequest.onBeforeRequest.mock.calls[0]![0]).toEqual({
    urls: ["<all_urls>"],
    types: ["mainFrame"],
  });
  expect(session.cancelled("https://blocked.test/", 10)).toBe(true);
  expect(session.cancelled("https://allowed.test/", 10)).toBe(false);
  expect(session.cancelled("https://blocked.test/", 11)).toBe(false);
  expect(session.cancelled("https://blocked.test/", 12)).toBe(false);
  expect(session.cancelled("https://blocked.test/")).toBe(false);
});

it("removes the gate when asked or when the contents is destroyed", () => {
  const session = fakeSession();
  const removed = fakeContents(20, session);
  const destroyed = fakeContents(21, session);
  const remove = gateMainFrameRequests(removed as never, () => true);
  gateMainFrameRequests(destroyed as never, () => true);

  remove();
  destroyed.emit("destroyed");
  expect(session.cancelled("https://blocked.test/", 20)).toBe(false);
  expect(session.cancelled("https://blocked.test/", 21)).toBe(false);
});
