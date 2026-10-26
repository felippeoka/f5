import * as Path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

export function assertFileActionCaller(input: {
  registered: boolean;
  mainFrame: boolean;
  origin: string;
  expectedOrigin: string;
  trustedGesture: unknown;
}): void {
  if (!input.registered || !input.mainFrame || input.origin !== input.expectedOrigin) {
    throw new Error("File actions require an F5 application main frame.");
  }
  if (input.trustedGesture !== true) throw new Error("File actions require a user gesture.");
}

export function vscodeFileUrl(targetPath: string): string {
  const url = new URL("vscode://file/");
  url.pathname = targetPath
    .replaceAll("\\", "/")
    .replace(/^(?!\/)/u, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
  return url.href;
}

async function resolveLocalTarget(raw: unknown, withPosition: boolean) {
  if (typeof raw !== "string" || raw.length > 32768 || raw.includes("\0")) {
    throw new Error("Invalid local file path.");
  }
  const match = withPosition ? /^(.*?)(:\d+(?::\d+)?)$/u.exec(raw) : null;
  const filePath = match?.[1] ?? raw;
  if (!Path.isAbsolute(filePath)) throw new Error("A local absolute path is required.");
  const absolutePath = await realpath(filePath);
  const entry = await stat(absolutePath);
  if (!entry.isFile() && !entry.isDirectory()) throw new Error("Unsupported filesystem entry.");
  return { absolutePath, directory: entry.isDirectory(), position: match?.[2] ?? "" };
}

export function registerDesktopFileActions(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  actions: {
    assertCaller: (event: IpcMainInvokeEvent, trustedGesture: unknown) => void;
    openExternal: (url: string) => Promise<void>;
    showItemInFolder: (filePath: string) => void;
    activateFileManager: () => Promise<void>;
  },
): void {
  ipc.removeHandler("desktop:open-in-vscode");
  ipc.handle("desktop:open-in-vscode", async (event, raw: unknown, trusted: unknown) => {
    actions.assertCaller(event, trusted);
    const target = await resolveLocalTarget(raw, true);
    await actions.openExternal(
      vscodeFileUrl(target.absolutePath + (target.directory ? "/" : target.position)),
    );
  });
  ipc.removeHandler("desktop:reveal-file");
  ipc.handle("desktop:reveal-file", async (event, raw: unknown, trusted: unknown) => {
    actions.assertCaller(event, trusted);
    const target = await resolveLocalTarget(raw, false);
    actions.showItemInFolder(target.absolutePath);
    await actions.activateFileManager();
  });
}
