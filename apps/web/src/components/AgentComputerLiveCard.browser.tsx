import "../index.css";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { AgentComputerLiveCard } from "./AgentComputerLiveCard";
import { ComputerAccessInbox } from "./ComputerAccessCard";

// Component regression only: no desktop host, grants or OS input are executed.
vi.mock("../nativeApi", () => ({ readNativeApi: () => undefined }));
const threadId = ThreadId.makeUnsafe("computer-ui-fixture");
beforeEach(() => useAgentComputerActivityStore.getState().resetConnection());
afterEach(() => {
  vi.restoreAllMocks();
  delete window.desktopBridge;
  useAgentComputerActivityStore.getState().resetConnection();
});

it("shows Pause after an old action's lease ends and keeps Resume visible once paused", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const store = useAgentComputerActivityStore.getState();
  const pause = vi.fn(async (id: string, paused: boolean) => store.setPaused(id, paused));
  window.desktopBridge = { computerAutomation: { setPaused: pause } } as never;
  store.record({ threadId, op: "type", status: "completed", backend: "native" });
  store.setLeases({
    holders: [{ threadId, backend: "native", delivery: "foreground", state: "active" }],
  });
  clock.mockReturnValue(130000);
  store.setLeases({ holders: [] });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(pause).toHaveBeenCalledWith(threadId, true);
    clock.mockReturnValue(200000);
    await expect.element(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("closes the real consent dialog only when its matching settlement arrives", async () => {
  const store = useAgentComputerActivityStore.getState();
  const answer = vi.fn(async () => {});
  window.desktopBridge = { computerAutomation: { answerAccess: answer } } as never;
  store.request({
    requestId: "consent",
    threadId,
    backendIncarnation: "fixture-backend",
    kind: "apps",
    reason: "Synthetic component test",
    apps: [{ appId: "fixture", name: "Synthetic fixture", tier: "full" }],
  });
  const screen = await render(<ComputerAccessInbox />);
  try {
    await expect.element(page.getByRole("dialog", { name: "Computer access" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(answer).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Review access", exact: true }).click();
    expect(answer).toHaveBeenCalledExactlyOnceWith({
      requestId: "consent",
      backendIncarnation: "fixture-backend",
      decisions: [],
    });
    store.settle({ requestId: "other", threadId, allowed: true });
    await expect.element(page.getByRole("dialog", { name: "Computer access" })).toBeVisible();
    store.settle({ requestId: "consent", threadId, allowed: true });
    await expect
      .element(page.getByRole("dialog", { name: "Computer access" }))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("retains idle controls while apps are granted and removes them after access is revoked", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const store = useAgentComputerActivityStore.getState();
  store.record({ threadId, op: "type", status: "completed", backend: "native" });
  store.setLeases({
    holders: [{ threadId, backend: "native", delivery: "foreground", state: "active" }],
  });
  store.setLeases({ holders: [] });
  store.setGrants(threadId, [{ appId: "fixture", tier: "full", allowTyping: false }]);
  clock.mockReturnValue(200000);
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Revoke fixture", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("fixture · Full control", { exact: true })).toBeVisible();
    store.setGrants(threadId, []);
    await expect.element(page.getByTestId("computer-live-card")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("renders an earlier capture after no-image actions and clears it on revoke", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.setGrants(threadId, [{ appId: "fixture", tier: "full", allowTyping: false }]);
  store.record({
    threadId,
    op: "activateApp",
    status: "completed",
    backend: "native",
    appName: "Synthetic fixture",
    thumbnailDataUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='gray'/%3E%3C/svg%3E",
  });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    const image = page.getByAltText("Last captured computer action");
    await expect.element(image).toBeVisible();
    store.record({ threadId, op: "type", status: "completed", backend: "native" });
    await expect.element(image).toBeVisible();
    await expect.element(page.getByTitle("Last capture · Synthetic fixture")).toBeVisible();
    await expect.element(page.getByText("Typed", { exact: true })).toBeVisible();
    store.setGrants(threadId, []);
    await expect.element(image).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

const accessRequest = (requestId: string, reason: string) => ({
  requestId,
  threadId,
  backendIncarnation: "fixture-backend",
  kind: "apps" as const,
  reason,
  apps: [{ appId: requestId, name: `App ${requestId}`, tier: "click" as const }],
});

it("lists allowed, refused and pending requests in the history popover", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.request(accessRequest("a", "First reason"));
  store.request(accessRequest("b", "Second reason"));
  store.request(accessRequest("c", "Third reason"));
  store.request({ ...accessRequest("d", "Fourth reason"), kind: "session-actions", apps: [] });
  store.settle({ requestId: "a", threadId, allowed: true });
  store.settle({ requestId: "b", threadId, allowed: false });
  store.settle({ requestId: "d", threadId, allowed: true });
  store.setGrants(threadId, [
    { appId: "a", tier: "click", allowTyping: false },
    { appId: "b", tier: "click", allowTyping: true },
  ]);
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByText("App a · Click", { exact: true })).toBeVisible();
    await expect.element(page.getByText("App b · Click + typing", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "History (4)", exact: true }).click();
    const list = page.getByTestId("computer-access-history");
    await expect.element(list).toBeVisible();
    const rows = list.getByRole("listitem");
    await expect.element(rows.nth(0)).toHaveTextContent("Requested: Session actionsFourth reason");
    await expect.element(rows.nth(1)).toHaveTextContent("Requested: App c · ClickThird reason");
    await expect.element(rows.nth(1).getByLabelText("Pending")).toBeInTheDocument();
    await expect.element(rows.nth(2).getByLabelText("Not allowed")).toBeInTheDocument();
    await expect.element(rows.nth(3).getByLabelText("Allowed")).toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("shows a compact summary that follows the latest request when only history remains", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.request(accessRequest("a", "Only reason"));
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect
      .element(page.getByText("Computer access · last request pending", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByTestId("computer-live-card")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "History (1)" }).click();
    const list = page.getByTestId("computer-access-history");
    await expect.element(list.getByLabelText("Pending")).toBeInTheDocument();
    store.settle({ requestId: "a", threadId, allowed: false });
    await expect.element(list.getByLabelText("Not allowed")).toBeInTheDocument();
    await expect
      .element(page.getByText("Computer access · last request not allowed", { exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("keeps Stop visible and clickable at a narrow width", async () => {
  const store = useAgentComputerActivityStore.getState();
  const setPaused = vi.fn(async () => {});
  window.desktopBridge = { computerAutomation: { setPaused } } as never;
  await page.viewport(320, 640);
  store.request(accessRequest("a", "Only reason"));
  store.settle({ requestId: "a", threadId, allowed: true });
  store.setGrants(threadId, [{ appId: "a", tier: "click", allowTyping: true }]);
  store.record({ threadId, op: "activateApp", status: "failed", backend: "native" });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect.element(stop).toBeVisible();
    const rect = stop.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    await stop.click();
    expect(setPaused).toHaveBeenCalledWith(threadId, true);
  } finally {
    await screen.unmount();
    await page.viewport(414, 896);
  }
});

it("names a built-in backend in the strip", async () => {
  const store = useAgentComputerActivityStore.getState();
  store.record({ threadId, op: "click", status: "started", backend: "claude-builtin" });
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByText("Clicking…", { exact: true })).toBeVisible();
    await expect.element(page.getByText("· via Claude", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("shows the tier badge and browser warning in the consent dialog", async () => {
  const store = useAgentComputerActivityStore.getState();
  window.desktopBridge = { computerAutomation: { answerAccess: vi.fn() } } as never;
  store.request({
    requestId: "consent-browser",
    threadId,
    backendIncarnation: "fixture-backend",
    kind: "apps",
    reason: "Open the dashboard",
    apps: [{ appId: "browser", name: "Synthetic browser", tier: "full", warning: "browser" }],
  });
  const screen = await render(<ComputerAccessInbox />);
  try {
    const dialog = page.getByRole("dialog", { name: "Computer access" });
    await expect.element(dialog.getByText("Full control", { exact: true })).toBeVisible();
    await expect
      .element(dialog.getByText("Can act on sites you're signed in to", { exact: true }))
      .toBeVisible();
    await expect.element(dialog.getByText("Open the dashboard", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
