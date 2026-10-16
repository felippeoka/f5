import type { AppUpdater } from "electron-updater";
import type { EventEmitter } from "node:events";

/** Isolates the private integration points verified against pinned electron-updater 6.8.3. */
export function createUpdaterInstallerAdapter(
  updater: AppUpdater,
  platform: NodeJS.Platform,
  options: { stagingTimeoutMs?: number } = {},
) {
  type BaseAttempt = {
    quitAndInstallCalled: boolean;
    app: { quit(): void };
    spawnLog(
      command: string,
      args?: string[],
      env?: NodeJS.ProcessEnv,
      stdio?: unknown,
    ): Promise<boolean>;
  };
  const base = updater as unknown as BaseAttempt;
  type Attempt = {
    failed: boolean;
    ready: boolean;
    quitRequested: boolean;
    spawns: Promise<boolean>[];
  };
  let attempt: Attempt | null = null;
  const quit = platform === "darwin" ? null : base.app.quit.bind(base.app);
  if (quit) {
    // BaseUpdater schedules app.quit unconditionally. Keep that callback from
    // killing a recovered session, and hold it until the Windows spawn settles.
    base.app.quit = () => {
      if (!attempt) {
        quit();
        return;
      }
      if (attempt.failed) return;
      if (attempt.ready) quit();
      else attempt.quitRequested = true;
    };
  }
  if (platform === "win32") {
    const spawnLog = base.spawnLog.bind(base);
    base.spawnLog = (...args) => {
      const spawn = spawnLog(...args).catch((cause: unknown) => {
        // Official NSIS installs are per-user. Do not start an unobserved
        // elevate.exe/openPath fallback after a failed launch.
        throw Object.assign(new Error("Could not start the update installer.", { cause }), {
          code: "F5_INSTALLER_LAUNCH_FAILED",
        });
      });
      attempt?.spawns.push(spawn);
      return spawn;
    };
  }
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
        const timer = setTimeout(
          () => failed(new Error("Preparing the update timed out. Try again.")),
          options.stagingTimeoutMs ?? 5 * 60_000,
        );
        timer.unref?.();
        const cleanup = () => {
          clearTimeout(timer);
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
    async install(): Promise<void> {
      if (platform === "darwin") {
        updater.quitAndInstall();
        return;
      }
      const current: Attempt = { failed: false, ready: false, quitRequested: false, spawns: [] };
      attempt = current;
      try {
        if (platform === "win32") updater.quitAndInstall(false, true);
        else updater.quitAndInstall();
        await Promise.all(current.spawns);
        if (current.failed) throw new Error("The update installation was cancelled.");
        current.ready = true;
        if (current.quitRequested) quit!();
      } catch (error) {
        current.failed = true;
        throw error;
      }
    },
    resetAttempt(): void {
      if (platform === "darwin") return;
      if (typeof base.quitAndInstallCalled !== "boolean")
        throw new Error("Unsupported electron-updater install state");
      if (attempt) attempt.failed = true;
      base.quitAndInstallCalled = false;
    },
  };
}
