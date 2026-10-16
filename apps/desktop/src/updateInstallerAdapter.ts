import type { AppUpdater } from "electron-updater";
import type { EventEmitter } from "node:events";

/** Isolates the private integration points verified against pinned electron-updater 6.8.3. */
export function createUpdaterInstallerAdapter(updater: AppUpdater, platform: NodeJS.Platform) {
  type BaseAttempt = { quitAndInstallCalled: boolean };
  type MacAttempt = {
    nativeUpdater: EventEmitter & { checkForUpdates(): void };
    squirrelDownloadedUpdate: boolean;
  };
  const mac = updater as unknown as MacAttempt;
  return {
    // Squirrel's staging/quit cannot be cancelled safely. Never restore the app
    // on a timer while native macOS installation could still complete and quit.
    watchdogEnabled: platform !== "darwin",
    async stage(): Promise<void> {
      if (platform !== "darwin" || mac.squirrelDownloadedUpdate) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          mac.nativeUpdater.removeListener("update-downloaded", downloaded);
          mac.nativeUpdater.removeListener("error", failed);
        };
        const downloaded = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        mac.nativeUpdater.once("update-downloaded", downloaded);
        mac.nativeUpdater.once("error", failed);
        try {
          mac.nativeUpdater.checkForUpdates();
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    },
    install(): void {
      if (platform === "win32") updater.quitAndInstall(false, true);
      else updater.quitAndInstall();
    },
    resetAttempt(): void {
      if (platform === "darwin") return;
      const base = updater as unknown as BaseAttempt;
      if (typeof base.quitAndInstallCalled !== "boolean")
        throw new Error("Unsupported electron-updater install state");
      base.quitAndInstallCalled = false;
    },
  };
}
