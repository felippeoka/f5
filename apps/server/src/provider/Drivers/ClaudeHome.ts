import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import { Effect, Path } from "effect";

import { expandHomePath } from "../../pathExpansion.ts";
import { accountUsageIdentity } from "../../usage/accountUsage.ts";

/**
 * Account identity for persisted usage history. Hashes the environment the
 * usage probe actually runs with, so a home-only configuration change is a
 * different account.
 */
export function claudeAccountUsageIdentity(binaryPath: string, env: NodeJS.ProcessEnv): string {
  return accountUsageIdentity("claude", [
    binaryPath,
    env.HOME,
    env.USERPROFILE,
    env.CLAUDE_CONFIG_DIR,
    env.ANTHROPIC_API_KEY,
  ]);
}

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  const path = yield* Path.Path;
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (
      [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      ].includes(key.toUpperCase())
    )
      delete env[key];
  }
  const drive = /^[a-z]:/i.exec(resolvedHomePath)?.[0];
  return {
    ...env,
    // macOS locates the login keychain relative to the real user home.
    // Claude isolates its keychain item using CLAUDE_CONFIG_DIR instead.
    HOME:
      platform === "darwin" && baseEnv.F5_PROFILE_ISOLATED === "1"
        ? NodeOS.homedir()
        : resolvedHomePath,
    USERPROFILE: resolvedHomePath,
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: resolvedHomePath.slice(2) } : {}),
    CLAUDE_CONFIG_DIR: path.join(resolvedHomePath, ".claude"),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(resolvedHomePath, ".claude"),
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}`;
  },
);
