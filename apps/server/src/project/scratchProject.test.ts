import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { gitCheckoutState, prepareScratchRoot, scratchProjectIdFor } from "./scratchProject.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
async function tempDir() {
  const root = await FS.realpath(await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-scratch-")));
  roots.push(root);
  return root;
}

describe("scratch project", () => {
  it("derives one UUID-shaped id per profile", () => {
    const id = scratchProjectIdFor("profile-a");
    expect(id).toBe(scratchProjectIdFor("profile-a"));
    expect(id).not.toBe(scratchProjectIdFor("profile-b"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("creates the scratch root outside a checkout and refuses one inside", async () => {
    const outside = await tempDir();
    expect(await gitCheckoutState(outside)).toBe("outside");
    const root = await prepareScratchRoot(Path.join(outside, "state"));
    expect(root).toBe(Path.join(outside, "state", "scratch"));
    expect((await FS.stat(root)).isDirectory()).toBe(true);

    const repo = await tempDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const state = Path.join(repo, ".f5");
    await FS.mkdir(state);
    expect(await gitCheckoutState(state)).toBe("inside");
    await expect(prepareScratchRoot(state)).rejects.toThrow("inside a Git checkout");
    await expect(FS.stat(Path.join(state, "scratch"))).rejects.toThrow();
  });
});
