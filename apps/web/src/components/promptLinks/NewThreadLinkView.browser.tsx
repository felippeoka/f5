import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

import { NewThreadLinkView } from "./NewThreadLinkView";

const api = vi.hoisted(() => ({
  projects: { findByRepository: vi.fn() },
  prHub: { getThreadsForPr: vi.fn(), peek: vi.fn() },
  git: { preparePullRequestThread: vi.fn() },
  server: { getConfig: vi.fn(async () => ({ providers: [] })) },
  orchestration: { dispatchCommand: vi.fn(async (_command: unknown) => ({ sequence: 1 })) },
  nextTurnQueue: { submit: vi.fn() },
}));
const createDraftThread = vi.hoisted(() => vi.fn());
const startScratchThread = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn(async () => {}));
const openClone = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("~/hooks/useCreateProjectBackedDraftThread", () => ({
  useCreateProjectBackedDraftThread: () => createDraftThread,
}));
vi.mock("~/hooks/useStartScratchThread", () => ({
  useStartScratchThread: () => startScratchThread,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("../ProjectCloneController", () => ({ openProjectCloneDialog: openClone }));
vi.mock("../ui/toast", () => ({ toastManager: toast }));
afterEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.setState({ draftsByThreadId: {} });
});

const search = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;
const draftPrompt = (threadId: ThreadId) =>
  useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt;
const project = {
  projectId: ProjectId.makeUnsafe("project-f5"),
  title: "f5",
  workspaceRoot: "/code/f5",
};

it("puts a link without a repository in a new thread without a project and never sends it", async () => {
  const threadId = ThreadId.makeUnsafe("scratch-draft");
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  const hidden = String.fromCodePoint(0x200b);
  await render(<NewThreadLinkView search={search({ prompt: `Fix the${hidden} build` })} />);

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Fix the build"));
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({ type: "warning", title: expect.stringContaining("hidden") }),
  );
  expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
  expect(api.nextTurnQueue.submit).not.toHaveBeenCalled();
});

it("still places the prompt when the link names a malformed provider", async () => {
  const threadId = ThreadId.makeUnsafe("malformed-provider-draft");
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  await render(
    <NewThreadLinkView search={search({ prompt: "Fix the build", provider: "foo.bar" })} />,
  );

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Fix the build"));
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({
      description: expect.stringContaining("foo.bar, which is not set up"),
    }),
  );
});

it("opens a link in the project whose remote matches its repository", async () => {
  const threadId = ThreadId.makeUnsafe("project-draft");
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  createDraftThread.mockResolvedValueOnce({ threadId, projectId: project.projectId });
  await render(
    <NewThreadLinkView search={search({ prompt: "Add tests", repo: "lopes-felipe/f5" })} />,
  );

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Add tests"));
  expect(api.projects.findByRepository).toHaveBeenCalledWith({ owner: "lopes-felipe", name: "f5" });
  expect(createDraftThread).toHaveBeenCalledWith(project.projectId);
  expect(startScratchThread).not.toHaveBeenCalled();
});

it("offers to clone a repository no project uses, or to go on without a project", async () => {
  const threadId = ThreadId.makeUnsafe("fallback-draft");
  api.projects.findByRepository.mockResolvedValueOnce([]);
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  const screen = await render(
    <NewThreadLinkView search={search({ prompt: "Add tests", repo: "octo/tools" })} />,
  );

  await screen.getByRole("button", { name: "Clone https://github.com/octo/tools" }).click();
  expect(openClone).toHaveBeenCalledWith("", "https://github.com/octo/tools");
  expect(createDraftThread).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Use without a project" }).click();
  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Add tests"));
});

it("checks out a pull request in a new worktree only after the user confirms", async () => {
  api.prHub.getThreadsForPr.mockResolvedValueOnce([]);
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  api.prHub.peek.mockResolvedValueOnce({ title: "Speed up search" });
  api.git.preparePullRequestThread.mockResolvedValueOnce({
    pullRequest: { title: "Speed up search" },
    branch: "pr-42",
    worktreePath: "/code/f5-worktrees/pr-42",
  });
  const screen = await render(
    <NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42", prompt: "Review it" })} />,
  );

  const confirm = screen.getByRole("button", { name: "Check out in a new worktree" });
  await expect.element(confirm).toBeInTheDocument();
  expect(api.prHub.getThreadsForPr).toHaveBeenCalledWith({
    key: "github:github.com/lopes-felipe/f5#42",
  });
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();

  await confirm.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(api.git.preparePullRequestThread).toHaveBeenCalledWith({
    cwd: "/code/f5",
    reference: "https://github.com/lopes-felipe/f5/pull/42",
    mode: "worktree",
  });
  const command = api.orchestration.dispatchCommand.mock.calls[0]![0] as {
    type: string;
    threadId: ThreadId;
    worktreePath: string;
    pullRequest: { number: number };
  };
  expect(command).toMatchObject({
    type: "thread.create",
    worktreePath: "/code/f5-worktrees/pr-42",
    pullRequest: { number: 42 },
  });
  expect(draftPrompt(command.threadId)).toBe("Review it");
  expect(api.nextTurnQueue.submit).not.toHaveBeenCalled();
});

it("opens the thread a pull request already has instead of checking it out again", async () => {
  const threadId = ThreadId.makeUnsafe("pr-thread");
  api.prHub.getThreadsForPr.mockResolvedValueOnce([{ threadId, title: "PR #42" }]);
  await render(<NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42" })} />);

  await vi.waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({ to: "/$threadId", params: { threadId } }),
  );
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();
});

it("explains a link it cannot open", async () => {
  const screen = await render(<NewThreadLinkView search={search({ repo: "octo/tools" })} />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("This link has no prompt.");
  expect(startScratchThread).not.toHaveBeenCalled();
});
