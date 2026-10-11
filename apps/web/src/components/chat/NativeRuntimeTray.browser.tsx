import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId, type NativeOperationRecord } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { NativeRuntimeTray } from "./NativeRuntimeTray";

const mocks = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<readonly NativeOperationRecord[]> => []),
  snapshot: vi.fn(async () => ({ entries: [] })),
  resolve: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    nativeOperations: { list: mocks.list, resolve: mocks.resolve },
    agents: { getSnapshot: mocks.snapshot },
  }),
}));

const at = "2020-01-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread");
const record = (
  state: NativeOperationRecord["state"],
  overrides: Partial<NativeOperationRecord> = {},
): NativeOperationRecord => ({
  operationId: "operation",
  threadId,
  generation: 1,
  state,
  command: { kind: "compact" },
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
const props = {
  threadId,
  capabilities: { generation: 1, discovery: "discovered" as const, checkedAt: at, actions: [] },
  activities: [],
  prompt: "",
  onSuggestion: () => {},
};
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("NativeRuntimeTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mocks.list.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders nothing for an idle thread", async () => {
    const screen = await render(<NativeRuntimeTray {...props} />);
    try {
      await nextFrame();
      expect(screen.container.childElementCount).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("does not let an older poll restore a resolved recovery row", async () => {
    mocks.list.mockResolvedValue([record("indeterminate")]);
    const screen = await render(<NativeRuntimeTray {...props} />);
    try {
      await expect
        .element(page.getByText("Compaction outcome is uncertain", { exact: true }))
        .toBeVisible();
      let finish!: (records: readonly NativeOperationRecord[]) => void;
      mocks.list.mockReturnValue(
        new Promise<readonly NativeOperationRecord[]>((resolve) => {
          finish = resolve;
        }),
      );
      vi.advanceTimersByTime(5000);
      expect(mocks.list).toHaveBeenCalledTimes(2);
      mocks.resolve.mockResolvedValue(record("completed"));
      await page.getByRole("button", { name: "Recheck outcome" }).click();
      await expect
        .element(page.getByText("Compaction outcome is uncertain", { exact: true }))
        .not.toBeInTheDocument();
      finish([record("indeterminate")]);
      await nextFrame();
      await nextFrame();
      expect(page.getByText("Compaction outcome is uncertain", { exact: true }).query()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("reports an operation that fails after it was admitted, once", async () => {
    const add = vi.spyOn(toastManager, "add");
    mocks.list.mockResolvedValue([record("running")]);
    const screen = await render(<NativeRuntimeTray {...props} />);
    try {
      await expect.element(page.getByText("Compaction running…")).toBeVisible();
      mocks.list.mockResolvedValue([record("failed", { error: "Provider refused." })]);
      vi.advanceTimersByTime(5000);
      await expect.element(page.getByText("Compaction running…")).not.toBeInTheDocument();
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Compaction failed", description: "Provider refused." }),
      );
      vi.advanceTimersByTime(5000);
      await nextFrame();
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
      await screen.unmount();
    }
  });
});
