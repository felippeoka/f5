import * as OS from "node:os";
import * as PathNode from "node:path";
import { Effect, Path } from "effect";
import { F5_HOME_DIR_NAME, USERDATA_STATE_DIR_NAME } from "@t3tools/shared/appStatePaths";
import { readPathFromLoginShell } from "@t3tools/shared/shell";
import { ensureWindowsPathHydrated } from "@t3tools/shared/windowsPath";

export async function fixPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // The desktop already ran these probes into the env this child inherits.
  // Repeating them costs a login shell, or seconds of PowerShell on Windows.
  if (env.F5_SHELL_ENVIRONMENT_PREPARED === "1") return;
  if (platform === "win32") {
    await ensureWindowsPathHydrated(env, {
      warn: (message) => console.warn(`[environment] ${message}`),
    });
    return;
  }
  if (platform !== "darwin") return;

  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const result = readPathFromLoginShell(shell);
    if (result) {
      env.PATH = result;
    }
  } catch {
    // Silently ignore — keep default PATH
  }
}

export function expandHomePathSync(input: string): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return PathNode.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export function resolveCodexHome(input?: {
  readonly homePath?: string | undefined;
}): string | undefined {
  const homePath = input?.homePath?.trim();
  return homePath ? expandHomePathSync(homePath) : undefined;
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(OS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveStateDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(OS.homedir(), F5_HOME_DIR_NAME, USERDATA_STATE_DIR_NAME);
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(OS.homedir(), F5_HOME_DIR_NAME);
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
