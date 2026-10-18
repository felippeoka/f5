import "../index.css";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { WorktreeChip } from "./WorktreeChip";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";
const mocks = vi.hoisted(() => ({
  reveal: vi.fn(),
  copy: vi.fn(),
  navigate: vi.fn(),
  editor: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ shell: { openInEditor: mocks.reveal } }),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("../editorPreferences", () => ({ openInPreferredEditor: mocks.editor }));
let screen: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  vi.clearAllMocks();
  useWorktreeRemovalDialogStore.setState({ requests: [] });
});
const threadId = ThreadId.makeUnsafe("chip");
const projectId = ProjectId.makeUnsafe("project");
const path = "/managed/topic with spaces ";
it("reveals the displayed checkout path for an unsent draft", async () => {
  mocks.reveal.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
  screen = await render(
    <WorktreeChip
      threadId={threadId}
      projectId={projectId}
      branch="feature/topic"
      path={path}
      isWorktree
    />,
  );
  const trigger = page.getByRole("button", { name: `Worktree: feature/topic · ${path}` });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
  expect(mocks.copy).toHaveBeenCalledWith(path);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Reveal", exact: true }).click();
  expect(mocks.reveal).toHaveBeenCalledWith(path, "file-manager");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  expect(useWorktreeRemovalDialogStore.getState().requests[0]?.rows).toEqual([{ projectId, path }]);
});
it("opens the local workspace picker and a terminal without polling", async () => {
  const terminal = vi.fn();
  screen = await render(
    <WorktreeChip
      threadId={threadId}
      projectId={projectId}
      branch="main"
      path="/repo"
      isWorktree={false}
      onOpenTerminal={terminal}
    />,
  );
  const trigger = page.getByRole("button", { name: "Local: main · /repo" });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Open terminal here" }).click();
  expect(terminal).toHaveBeenCalledOnce();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Use existing worktree…" }).click();
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/worktrees",
    search: { projectId, threadId },
  });
});

it("supports keyboard opening and returns focus after Escape", async () => {
  screen = await render(
    <WorktreeChip
      threadId={threadId}
      projectId={projectId}
      branch="topic"
      path="/managed/topic"
      isWorktree
    />,
  );
  const trigger = page.getByRole("button", { name: "Worktree: topic · /managed/topic" });
  await trigger.unhover();
  await userEvent.tab();
  await expect.element(trigger, { timeout: 1000 }).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("menuitem", { name: "Copy path", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger, { timeout: 1000 }).toHaveFocus();
});
