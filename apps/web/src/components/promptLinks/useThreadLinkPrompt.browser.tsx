import "../../index.css";
import { ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";

import { useThreadLinkPrompt } from "./useThreadLinkPrompt";

const toast = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: toast }));
afterEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.setState({ draftsByThreadId: {} });
});

function ThreadHarness() {
  const threadId = ThreadId.makeUnsafe(useParams({ strict: false }).threadId ?? "");
  useThreadLinkPrompt(threadId, true);
  const href = useLocation({ select: (location) => location.href });
  return <output aria-label="location">{href}</output>;
}

function renderAt(path: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$threadId",
    component: ThreadHarness,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: rootRoute.addChildren([threadRoute]),
  });
  return render(<RouterProvider router={router} />);
}

const draftPrompt = (threadId: string) =>
  useComposerDraftStore.getState().draftsByThreadId[ThreadId.makeUnsafe(threadId)]?.prompt;

it("fills the thread's composer and removes the link's prompt from the URL", async () => {
  const screen = await renderAt("/thread-1?prompt=Retry%20the%20deploy&diff=1");
  await vi.waitFor(() => expect(draftPrompt("thread-1")).toBe("Retry the deploy"));
  await expect.element(screen.getByLabelText("location")).toHaveTextContent("/thread-1?diff=1");
});

it("asks before replacing a draft the thread already has", async () => {
  useComposerDraftStore.getState().setPrompt(ThreadId.makeUnsafe("thread-2"), "my own words");
  const screen = await renderAt("/thread-2?prompt=Linked");
  await expect.element(screen.getByLabelText("location")).toHaveTextContent(/^\/thread-2$/);
  expect(draftPrompt("thread-2")).toBe("my own words");
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({
      actionProps: expect.objectContaining({ children: "Replace draft" }),
    }),
  );
});
