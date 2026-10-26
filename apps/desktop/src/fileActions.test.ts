import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { assertFileActionCaller, registerDesktopFileActions, vscodeFileUrl } from "./fileActions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(Path.join(tmpdir(), "f5-native-files-"));
  roots.push(root);
  const file = Path.join(root, "sample #1%.json");
  await writeFile(file, "{}");
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  const ipc: Pick<IpcMain, "handle" | "removeHandler"> = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const actions = {
    assertCaller: vi.fn((_event: IpcMainInvokeEvent, trusted: unknown) => {
      if (trusted !== true) throw new Error("File actions require a user gesture.");
    }),
    openExternal: vi.fn(async (_url: string) => {}),
    showItemInFolder: vi.fn((_path: string) => {}),
    activateFileManager: vi.fn(async () => {}),
  };
  registerDesktopFileActions(ipc, actions);
  return {
    file,
    canonical: await realpath(file),
    actions,
    invoke: (channel: string, path: string, trusted: unknown = true) =>
      handlers.get(channel)!({} as IpcMainInvokeEvent, path, trusted),
  };
}

it("opens VS Code through its native file URL, preserving positions and escaping filenames", async () => {
  const f = await fixture();
  await f.invoke("desktop:open-in-vscode", `${f.file}:42:7`);
  expect(f.actions.openExternal).toHaveBeenCalledWith(
    `vscode://file/${f.canonical.replaceAll("\\", "/").replace(/^\//u, "").replaceAll("%", "%25").replaceAll(" ", "%20").replaceAll("#", "%23")}:42:7`,
  );
});

it("reveals the existing file before activating the file manager, keeping the selection", async () => {
  const f = await fixture();
  await f.invoke("desktop:reveal-file", f.file);
  expect(f.actions.showItemInFolder).toHaveBeenCalledWith(f.canonical);
  expect(f.actions.activateFileManager).toHaveBeenCalledOnce();
  expect(f.actions.showItemInFolder.mock.invocationCallOrder[0]).toBeLessThan(
    f.actions.activateFileManager.mock.invocationCallOrder[0]!,
  );
});

it.each(["desktop:reveal-file", "desktop:open-in-vscode"])(
  "rejects missing files, relative paths, and absent gestures for %s",
  async (channel) => {
    const f = await fixture();
    await expect(f.invoke(channel, f.file + ".missing")).rejects.toThrow();
    await expect(f.invoke(channel, "relative.json")).rejects.toThrow("absolute path");
    await expect(f.invoke(channel, f.file, false)).rejects.toThrow("user gesture");
    expect(f.actions.openExternal).not.toHaveBeenCalled();
    expect(f.actions.showItemInFolder).not.toHaveBeenCalled();
  },
);

it("propagates native launch and Finder activation errors", async () => {
  const f = await fixture();
  f.actions.openExternal.mockRejectedValue(new Error("VS Code is not installed"));
  await expect(f.invoke("desktop:open-in-vscode", f.file)).rejects.toThrow(
    "VS Code is not installed",
  );
  f.actions.activateFileManager.mockRejectedValue(new Error("Cannot activate Finder"));
  await expect(f.invoke("desktop:reveal-file", f.file)).rejects.toThrow("Cannot activate Finder");
});

it("builds Windows VS Code file URLs without treating drive letters as a protocol", () => {
  expect(vscodeFileUrl("C:\\My Files\\file.ts:8:2")).toBe(
    "vscode://file/C:/My%20Files/file.ts:8:2",
  );
});

it.each([
  { registered: false },
  { mainFrame: false },
  { origin: "https://untrusted.invalid" },
  { trustedGesture: false },
])("rejects unauthorized desktop file actions: %j", (override) => {
  expect(() =>
    assertFileActionCaller({
      registered: true,
      mainFrame: true,
      origin: "f5://app",
      expectedOrigin: "f5://app",
      trustedGesture: true,
      ...override,
    }),
  ).toThrow();
});
