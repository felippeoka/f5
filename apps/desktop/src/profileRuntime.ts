import type { ProfileRecord } from "@t3tools/contracts";
import type { ChildProcess } from "node:child_process";

interface ProfileBackendRuntime {
  backendProcess: ChildProcess | null;
  stopped: boolean;
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

export function isProfileBackendRunning(runtime: ProfileBackendRuntime): boolean {
  const child = runtime.backendProcess;
  return !!child?.pid && !child.killed && child.exitCode === null && child.signalCode === null;
}

/** A retained window and a cached runtime are not evidence of a running backend. */
export async function ensureProfileBackend(
  runtime: ProfileBackendRuntime,
  operations: {
    readonly stop: () => Promise<void>;
    readonly prepare: () => Promise<void>;
    readonly start: () => void;
    readonly ready: () => Promise<void>;
  },
): Promise<void> {
  if (runtime.stopped || !isProfileBackendRunning(runtime)) {
    if (runtime.backendProcess) await operations.stop();
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
    runtime.restartAttempt = 0;
    runtime.stopped = true;
    await operations.prepare();
    runtime.stopped = false;
    operations.start();
  }
  await operations.ready();
}

export async function waitForProfileBackend(
  isRunning: () => boolean,
  checkReady: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning()) {
    if (await checkReady()) {
      if (isRunning()) return;
      break;
    }
    if (Date.now() >= deadline)
      throw new Error("Backend startup timed out. Check server-child.log.");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Backend stopped before becoming ready. Check server-child.log.");
}

export const MAX_ACTIVE_PROFILE_BACKENDS = 6;
export const profilePartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? undefined : `persist:f5-profile-${profile.id}`;
export const profilePreviewPartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? "persist:f5-preview" : `persist:f5-profile-preview-${profile.id}`;
export const profileWindowArguments = (profileId: string) => [`--f5-profile-id=${profileId}`];

/** Existing windows retain their preload URL when a stopped backend reopens. */
export async function ensureProfileConnection(
  runtime: { backendPort: number; backendAuthToken: string; backendWsUrl: string },
  reservePort: () => Promise<number>,
  mintToken: () => string,
  websocketUrl: (port: number, token: string) => string,
): Promise<void> {
  if (!runtime.backendPort) runtime.backendPort = await reservePort();
  if (!runtime.backendAuthToken) runtime.backendAuthToken = mintToken();
  runtime.backendWsUrl = websocketUrl(runtime.backendPort, runtime.backendAuthToken);
}

/** Coalesce concurrent window/menu requests before asynchronous port allocation. */
export function singleProfileOpen<T>(open: (id: string) => Promise<T>): (id: string) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  return (id) => {
    const existing = pending.get(id);
    if (existing) return existing;
    const result = Promise.resolve().then(() => open(id));
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => {});
    return result;
  };
}
