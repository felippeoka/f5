import { afterEach, describe, expect, it, vi } from "vitest";

const readPathFromLoginShell = vi.fn(() => "/login/shell/bin");
const ensureWindowsPathHydrated = vi.fn(async () => undefined);
vi.mock("@t3tools/shared/shell", () => ({ readPathFromLoginShell }));
vi.mock("@t3tools/shared/windowsPath", () => ({ ensureWindowsPathHydrated }));

const { fixPath } = await import("./os-jank.ts");

afterEach(() => vi.clearAllMocks());

describe("fixPath", () => {
  it("reads the login shell PATH when the server starts on its own", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await fixPath(env, "darwin");
    expect(readPathFromLoginShell).toHaveBeenCalledOnce();
    expect(env.PATH).toBe("/login/shell/bin");
  });

  it("skips the probes the desktop already ran into the inherited environment", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const env: NodeJS.ProcessEnv = { PATH: "/desktop/bin", F5_SHELL_ENVIRONMENT_PREPARED: "1" };
      await fixPath(env, platform);
      expect(env.PATH).toBe("/desktop/bin");
    }
    expect(readPathFromLoginShell).not.toHaveBeenCalled();
    expect(ensureWindowsPathHydrated).not.toHaveBeenCalled();
  });
});
