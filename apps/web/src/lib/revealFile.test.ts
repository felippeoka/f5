import { beforeEach, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { revealFile } from "./revealFile";

const context = {
  projectId: ProjectId.makeUnsafe("project-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
};

const mocks = vi.hoisted(() => ({ reveal: vi.fn(), read: vi.fn(), toast: vi.fn() }));
vi.mock("../nativeApi", () => ({ readNativeApi: mocks.read }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockReturnValue({ shell: { revealInFileManager: mocks.reveal } });
});

it.each([
  ["src/app.ts", "/repo", "/repo", "src/app.ts"],
  ["/tmp/external/report.json", "/repo", "/tmp/external", "report.json"],
])("reveals %s using its actual directory", async (file, workspace, cwd, relativePath) => {
  await revealFile(file, workspace, context);
  expect(mocks.reveal).toHaveBeenCalledWith({
    ...context,
    ...(file.startsWith("/") ? { cwd } : {}),
    relativePath,
    kind: "file",
  });
});

it("reports a failed reveal with the path", async () => {
  mocks.reveal.mockRejectedValue(new Error("File not found"));
  await revealFile("/tmp/missing.json", undefined, context);
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Unable to reveal file",
    description: "/tmp/missing.json: File not found",
  });
});

it("reports an unavailable native API", async () => {
  mocks.read.mockReturnValue(undefined);
  await revealFile("/tmp/report.json", undefined, context);
  expect(mocks.reveal).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "/tmp/report.json: File manager is unavailable.",
    }),
  );
});
