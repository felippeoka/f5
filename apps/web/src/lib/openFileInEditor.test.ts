import { beforeEach, expect, it, vi } from "vitest";
import { openFileInEditor } from "./openFileInEditor";

const mocks = vi.hoisted(() => ({ api: {}, open: vi.fn(), read: vi.fn(), toast: vi.fn() }));
vi.mock("../editorPreferences", () => ({ openInPreferredEditor: mocks.open }));
vi.mock("../nativeApi", () => ({ readNativeApi: mocks.read }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockReturnValue(mocks.api);
});

it("preserves the full target and position when opening an editor", async () => {
  const target = "/tmp/report.json:4:2";
  await openFileInEditor(target);
  expect(mocks.open).toHaveBeenCalledWith(mocks.api, target);
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("reports rejected editor handoffs with the file path", async () => {
  mocks.open.mockRejectedValue(new Error("Editor launch failed"));
  await expect(openFileInEditor("/tmp/report.json")).resolves.toBeUndefined();
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Unable to open file",
    description: "/tmp/report.json: Editor launch failed",
  });
});

it("reports an unavailable native API", async () => {
  mocks.read.mockReturnValue(undefined);
  await openFileInEditor("/tmp/report.json");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "/tmp/report.json: Editor opening is unavailable.",
    }),
  );
});
