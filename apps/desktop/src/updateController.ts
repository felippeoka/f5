import type {
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { electronUpdaterChannelSettings } from "./updateChannel";
import {
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnUpdateAvailable,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnDownloadFailure,
} from "./updateMachine";

export interface UpdaterPort {
  check(): Promise<{ version: string; releaseNotes: string | null } | null>;
  download(): Promise<unknown>;
  applySettings(settings: {
    channel: string;
    allowPrerelease: boolean;
    allowDowngrade: false;
  }): void;
}
export function createUpdateController(options: {
  port: UpdaterPort;
  getState(): DesktopUpdateState;
  emit(state: DesktopUpdateState): void;
  writePreferences(channel: DesktopUpdateChannel): void;
  timeoutMs?: number;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  let pendingCheck: Promise<DesktopUpdateActionResult> | null = null;
  // electron-updater coalesces native checks internally. After a timeout, drain that
  // request before starting another, so a channel change cannot reuse its result.
  let activePortCheck: ReturnType<UpdaterPort["check"]> | null = null;
  const result = (accepted: boolean): DesktopUpdateActionResult => ({
    accepted,
    completed: accepted && options.getState().status !== "error",
    state: options.getState(),
  });
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const applyChannel = (channel: DesktopUpdateChannel) =>
    options.port.applySettings({
      ...electronUpdaterChannelSettings(channel),
      allowDowngrade: false,
    });
  async function check(): Promise<DesktopUpdateActionResult> {
    const state = options.getState();
    if (!state.enabled || state.status === "downloaded" || state.status === "downloading")
      return result(false);
    options.emit(reduceDesktopUpdateStateOnCheckStart(state));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const runPortCheck = async () => {
      while (activePortCheck) {
        await activePortCheck.catch(() => undefined);
        if (expired) return null;
      }
      if (expired) return null;
      const request = options.port.check();
      activePortCheck = request;
      try {
        return await request;
      } finally {
        if (activePortCheck === request) activePortCheck = null;
      }
    };
    try {
      const info = await Promise.race([
        runPortCheck(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("Update check timed out. Try again."));
          }, options.timeoutMs ?? 30_000);
        }),
      ]);
      const now = new Date().toISOString();
      options.emit(
        info
          ? reduceDesktopUpdateStateOnUpdateAvailable(
              options.getState(),
              info.version,
              now,
              info.releaseNotes,
            )
          : reduceDesktopUpdateStateOnNoUpdate(options.getState(), now),
      );
    } catch (error) {
      options.emit(
        reduceDesktopUpdateStateOnCheckFailure(
          options.getState(),
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
    return result(true);
  }
  return {
    applyChannel,
    requestCheck(_reason: string) {
      if (!pendingCheck)
        pendingCheck = enqueue(check).finally(() => {
          pendingCheck = null;
        });
      return pendingCheck;
    },
    download() {
      return enqueue(async () => {
        if (options.getState().status !== "available") return result(false);
        options.emit(reduceDesktopUpdateStateOnDownloadStart(options.getState()));
        try {
          await options.port.download();
          return result(true);
        } catch (error) {
          options.emit(
            reduceDesktopUpdateStateOnDownloadFailure(
              options.getState(),
              error instanceof Error ? error.message : String(error),
            ),
          );
          return { ...result(true), completed: false };
        }
      });
    },
    setChannel(channel: DesktopUpdateChannel) {
      if (options.getState().status === "downloading") return Promise.resolve(result(false));
      return enqueue(async () => {
        if (channel !== "stable" && channel !== "beta") throw new Error("Invalid update channel");
        options.writePreferences(channel);
        applyChannel(channel);
        const state = options.getState();
        options.emit({
          ...state,
          channel,
          ...(!state.enabled || state.status === "downloaded"
            ? {}
            : { status: "idle", availableVersion: null, releaseNotes: null }),
        });
        return !state.enabled || state.status === "downloaded" ? result(true) : check();
      });
    },
  };
}
