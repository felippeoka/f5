import "../index.css";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
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
  store.setLease({ threadId, backend: "native" });
  clock.mockReturnValue(130000);
  store.setLease({ threadId: null });
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
    await page.getByRole("button", { name: "Allow selected", exact: true }).click();
    expect(answer).toHaveBeenCalledExactlyOnceWith({
      requestId: "consent",
      backendIncarnation: "fixture-backend",
      decisions: [{ appId: "fixture", allow: true, allowTyping: false, remember: false }],
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
  store.setLease({ threadId, backend: "native" });
  store.setLease({ threadId: null });
  store.setGrants(threadId, [{ appId: "fixture", tier: "full", allowTyping: false }]);
  clock.mockReturnValue(200000);
  const screen = await render(<AgentComputerLiveCard threadId={threadId} />);
  try {
    await expect.element(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
    await expect.element(page.getByText("Computer access · F5", { exact: true })).toBeVisible();
    store.setGrants(threadId, []);
    await expect.element(page.getByTestId("computer-live-card")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
