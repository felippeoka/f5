import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { BaseUpdater as BaseType } from "electron-updater/out/BaseUpdater";
import type { MacUpdater as MacType } from "electron-updater/out/MacUpdater";
import { createUpdaterInstallerAdapter } from "./updateInstallerAdapter";
import { createUpdateInstaller } from "./updateInstall";
const require = createRequire(import.meta.url);
const { BaseUpdater } = require("electron-updater/out/BaseUpdater") as {
  BaseUpdater: typeof BaseType;
};
class NativeBaseUpdater extends BaseUpdater {
  calls = 0;
  constructor() {
    super(null, { version: "0.1.0" } as never);
    this.logger = null;
    this.downloadedUpdateHelper = { file: "installer", downloadedFileInfo: {} } as never;
  }
  get payloadPath() {
    return this.installerPath;
  }
  protected async doDownloadUpdate(): Promise<string[]> {
    throw new Error("Unexpected download in install regression");
  }
  protected doInstall() {
    this.calls++;
    return true;
  }
  // Only the OS quit scheduling is replaced. The real BaseUpdater.install
  // implementation, its downloaded payload, and its attempt guard are exercised.
  override quitAndInstall(silent = false, forceRun = false) {
    this.install(silent, forceRun);
  }
}
it.each(["error", "watchdog"])(
  "resets the real BaseUpdater guard after %s and installs again",
  async (failure) => {
    vi.useFakeTimers();
    try {
      const native = new NativeBaseUpdater();
      const adapter = createUpdaterInstallerAdapter(native, "win32");
      const recover = vi.fn(async () => {});
      const installer = createUpdateInstaller({
        canInstall: () => true,
        confirm: async () => true,
        prepare: async () => true,
        install: adapter.install,
        resetAttempt: adapter.resetAttempt,
        recover,
        timeoutMs: 60_000,
      });
      let recovered: Promise<void> | undefined;
      native.on("error", (error: Error) => {
        recovered = installer.onError(error.message);
      });
      await installer.request();
      expect(native.calls).toBe(1);
      // Prove a retry without the adapter reset really is ignored by 6.8.3.
      native.install();
      expect(native.calls).toBe(1);
      if (failure === "error") {
        native.emit("error", new Error("async installer failure"));
        await recovered;
      } else await vi.advanceTimersByTimeAsync(60_001);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(native.payloadPath).toBe("installer");
      await installer.request();
      expect(native.calls).toBe(2);
      await installer.onError("finish test");
    } finally {
      vi.useRealTimers();
    }
  },
);
it.each([false, true])(
  "stages using real MacUpdater before cleanup without a handoff timeout (stage error first: %s)",
  async (failFirst) => {
    vi.useFakeTimers();
    const native = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    const electronPath = require.resolve("electron");
    const previous = require.cache[electronPath];
    require.cache[electronPath] = { exports: { autoUpdater: native } } as NodeModule;
    try {
      const { MacUpdater } = require("electron-updater/out/MacUpdater") as {
        MacUpdater: typeof MacType;
      };
      const updater = new MacUpdater(undefined, { version: "0.1.0" } as never);
      updater.logger = null;
      const adapter = createUpdaterInstallerAdapter(updater, "darwin");
      const prepare = vi.fn(async () => true);
      const recover = vi.fn(async () => {});
      const installer = createUpdateInstaller({
        canInstall: () => true,
        confirm: async () => true,
        stage: adapter.stage,
        prepare,
        install: adapter.install,
        resetAttempt: adapter.resetAttempt,
        watchdogEnabled: adapter.watchdogEnabled,
        recover,
      });
      if (failFirst) {
        const failed = installer.request();
        await vi.advanceTimersByTimeAsync(1);
        native.emit("error", new Error("Squirrel staging failed"));
        expect((await failed).completed).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        // Only MacUpdater's permanent state listener remains. No delayed native
        // update-downloaded event can trigger a quit after failure recovery.
        expect(native.listenerCount("update-downloaded")).toBe(1);
        expect(native.quitAndInstall).not.toHaveBeenCalled();
        recover.mockClear();
        native.checkForUpdates.mockClear();
      }
      const request = installer.request();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      native.emit("update-downloaded");
      await request;
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      if (previous) require.cache[electronPath] = previous;
      else delete require.cache[electronPath];
      vi.useRealTimers();
    }
  },
);
