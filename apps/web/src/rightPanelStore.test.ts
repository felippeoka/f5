import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectSurfaceHeaderState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("rightPanelStore", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadId: {}, closedByThreadId: {}, tabMenuThreadId: null });
  });

  it("adds agent surfaces without opening the panel or stealing the active tab", () => {
    useRightPanelStore.getState().addSurface(THREAD_A, "preview");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      { isOpen: false, activeSurfaceId: "preview", surfaces: [{ id: "preview", kind: "preview" }] },
    );
    useRightPanelStore.getState().open(THREAD_B, "diff");
    useRightPanelStore.getState().addSurface(THREAD_B, "preview");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_B)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [
          { id: "diff", kind: "diff" },
          { id: "preview", kind: "preview" },
        ],
      },
    );
    useRightPanelStore.getState().addSurface(THREAD_B, "preview", { activate: true });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_B)
        .activeSurfaceId,
    ).toBe("preview");
  });

  it("opens singleton surfaces and focuses the last opened surface", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_A, "plan");
    useRightPanelStore.getState().open(THREAD_A, "agents");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "agents",
        surfaces: [
          { id: "diff", kind: "diff" },
          { id: "plan", kind: "plan" },
          { id: "agents", kind: "agents" },
        ],
      },
    );
  });

  it("updates an existing file surface and keeps its tab order", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().openFile(THREAD_A, {
      relativePath: "src/app.ts",
      line: 1,
    });
    useRightPanelStore.getState().openFile(THREAD_A, {
      relativePath: "src/app.ts",
      line: 42,
      endLine: 44,
      column: 7,
    });

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "file:src/app.ts",
        surfaces: [
          { id: "diff", kind: "diff" },
          {
            id: "file:src/app.ts",
            kind: "file",
            relativePath: "src/app.ts",
            line: 42,
            endLine: 44,
            column: 7,
          },
        ],
      },
    );
  });

  it("closing the active surface falls back to the neighbor", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_A, "plan");

    useRightPanelStore.getState().closeSurface(THREAD_A, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    );
  });

  it("supports close other, close to right, and close all actions", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().openFile(THREAD_A, { relativePath: "src/app.ts" });
    useRightPanelStore.getState().open(THREAD_A, "plan");

    useRightPanelStore.getState().closeSurfacesToRight(THREAD_A, "diff");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    );

    useRightPanelStore.getState().openFile(THREAD_A, { relativePath: "src/app.ts" });
    useRightPanelStore.getState().open(THREAD_A, "plan");
    useRightPanelStore.getState().closeOtherSurfaces(THREAD_A, "file:src/app.ts");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "file:src/app.ts",
        surfaces: [{ id: "file:src/app.ts", kind: "file", relativePath: "src/app.ts" }],
      },
    );

    useRightPanelStore.getState().closeAllSurfaces(THREAD_A);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
      },
    );
  });

  it("can hide a panel without dropping its tabs", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().openFile(THREAD_A, { relativePath: "src/app.ts" });

    useRightPanelStore.getState().close(THREAD_A);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: false,
        activeSurfaceId: "file:src/app.ts",
        surfaces: [
          { id: "diff", kind: "diff" },
          { id: "file:src/app.ts", kind: "file", relativePath: "src/app.ts" },
        ],
      },
    );
  });

  it("removes all state for a deleted thread", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_B, "plan");

    useRightPanelStore.getState().removeThread(THREAD_A);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
      },
    );
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_B)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "plan",
        surfaces: [{ id: "plan", kind: "plan" }],
      },
    );
  });

  it("keeps thread state isolated", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_B, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    );
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_B)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "plan",
        surfaces: [{ id: "plan", kind: "plan" }],
      },
    );
  });

  it("derives header toggle state from panel visibility and the active tab", () => {
    const state = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A);
    expect(selectSurfaceHeaderState(state(), "preview")).toBe("closed");

    useRightPanelStore.getState().open(THREAD_A, "agents");
    useRightPanelStore.getState().open(THREAD_A, "preview");
    expect(selectSurfaceHeaderState(state(), "preview")).toBe("active");
    expect(selectSurfaceHeaderState(state(), "agents")).toBe("background");
    expect(selectSurfaceHeaderState(state(), "diff")).toBe("closed");

    useRightPanelStore.getState().close(THREAD_A);
    expect(selectSurfaceHeaderState(state(), "preview")).toBe("closed");
    expect(selectSurfaceHeaderState(state(), "agents")).toBe("closed");
  });
});

describe("right panel order and closed history", () => {
  beforeEach(() =>
    useRightPanelStore.setState({ byThreadId: {}, closedByThreadId: {}, tabMenuThreadId: null }),
  );
  it("moves tabs without changing the active surface and ignores invalid positions", () => {
    const store = useRightPanelStore.getState();
    store.open(THREAD_A, "diff");
    store.open(THREAD_A, "plan");
    store.open(THREAD_A, "agents");
    store.moveSurface(THREAD_A, 0, 2);
    const panel = useRightPanelStore.getState().byThreadId[THREAD_A]!;
    expect(panel.surfaces.map((surface) => surface.id)).toEqual(["plan", "agents", "diff"]);
    expect(panel.activeSurfaceId).toBe("agents");
    for (const [from, to] of [
      [-1, 0],
      [0, 9],
      [1.5, 0],
      [0, NaN],
      [1, 1],
    ])
      store.moveSurface(THREAD_A, from!, to!);
    expect(useRightPanelStore.getState().byThreadId[THREAD_A]).toBe(panel);
  });
  it("reopens full file locations in LIFO order after bulk and individual closes", () => {
    const store = useRightPanelStore.getState();
    store.open(THREAD_A, "diff");
    store.openFile(THREAD_A, { relativePath: "src/a.ts", line: 12, endLine: 15, column: 3 });
    store.open(THREAD_A, "plan");
    store.closeSurfacesToRight(THREAD_A, "diff");
    expect(store.reopenClosed(THREAD_A)?.kind).toBe("plan");
    expect(store.reopenClosed(THREAD_A)).toEqual({
      id: "file:src/a.ts",
      kind: "file",
      relativePath: "src/a.ts",
      line: 12,
      endLine: 15,
      column: 3,
    });
    expect(useRightPanelStore.getState().byThreadId[THREAD_A]?.isOpen).toBe(true);
    store.closeAllSurfaces(THREAD_A);
    expect(store.reopenClosed(THREAD_A)?.id).toBe("file:src/a.ts");
  });
  it("retains at most twenty tabs per thread and removes history when its thread is removed", () => {
    const store = useRightPanelStore.getState();
    for (let index = 0; index < 25; index++) {
      const file = store.openFile(THREAD_A, { relativePath: `file-${index}` });
      store.closeSurface(THREAD_A, file.id);
    }
    expect(useRightPanelStore.getState().closedByThreadId[THREAD_A]).toHaveLength(20);
    expect(store.reopenClosed(THREAD_B)).toBeNull();
    expect(store.reopenClosed(THREAD_A)?.id).toBe("file:file-24");
    store.closeAllSurfaces(THREAD_A);
    store.setTabMenuThread(THREAD_A);
    store.removeThread(THREAD_A);
    expect(useRightPanelStore.getState().closedByThreadId[THREAD_A]).toBeUndefined();
    expect(useRightPanelStore.getState().tabMenuThreadId).toBeNull();
    expect(store.reopenClosed(THREAD_A)).toBeNull();
  });
  it("does not remember hidden panels or reopen a duplicate tab", () => {
    const store = useRightPanelStore.getState();
    store.open(THREAD_A, "diff");
    store.close(THREAD_A);
    expect(store.reopenClosed(THREAD_A)).toBeNull();
    store.closeSurface(THREAD_A, "diff");
    store.open(THREAD_A, "diff");
    expect(store.reopenClosed(THREAD_A)).toBeNull();
    expect(useRightPanelStore.getState().byThreadId[THREAD_A]?.surfaces).toHaveLength(1);
  });
});

it("keeps one PR tab per reference and restores it through normal close history", () => {
  const thread = ThreadId.makeUnsafe("pr-panels");
  const key = "github:github.com/org/repo#7" as import("@t3tools/contracts").PullRequestKey;
  const store = useRightPanelStore.getState();
  store.openPullRequest(thread, { key, url: "https://github.com/org/repo/pull/7" });
  store.openPullRequest(thread, { key, url: "https://github.com/org/repo/pull/7#discussion" });
  expect(useRightPanelStore.getState().byThreadId[thread]?.surfaces).toHaveLength(1);
  store.closeSurface(thread, `pr:${key}`);
  expect(store.reopenClosed(thread)).toMatchObject({
    kind: "pull-request",
    key,
    url: "https://github.com/org/repo/pull/7#discussion",
  });
});
