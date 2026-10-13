import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { Identity } from "./model";
import type { Platform } from "./catalog";

const exec = promisify(execFile);
export const hashFile = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const full = join(path, entry.name);
      hash.update(relative(root, full));
      if (entry.isSymbolicLink())
        throw new Error("Unexpected symbolic link in certification payload");
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) hash.update(await readFile(full));
    }
  }
  await walk(root);
  return hash.digest("hex");
}
export interface Target {
  readonly repo: string;
  readonly platform: Platform;
  readonly arch?: "arm64" | "x64";
  readonly app?: string;
  readonly helper?: string;
  readonly fixtureDirectory?: string;
}
export function helperPath(target: Target) {
  return (
    target.helper ??
    (target.app
      ? target.platform === "darwin"
        ? join(target.app, "Contents/Resources/native/f5-computer-helper")
        : join(target.app, "resources/native/f5-computer-helper.exe")
      : join(
          target.repo,
          "apps/desktop/dist-native",
          (target.platform === "darwin" ? "mac-" : "win-") + (target.arch ?? process.arch),
          target.platform === "darwin" ? "f5-computer-helper" : "f5-computer-helper.exe",
        ))
  );
}
export async function identify(target: Target): Promise<Identity> {
  if (target.app && target.helper) throw new Error("Installed target cannot replace its helper");
  const files: Record<string, string> = {};
  if (process.platform === target.platform || target.app || target.helper)
    files.helper = await hashFile(helperPath(target));
  if (target.app) {
    const resourceRoot = join(
      target.app,
      target.platform === "darwin" ? "Contents/Resources" : "resources",
    );
    const helper = await realpath(helperPath(target));
    const rel = relative(await realpath(resourceRoot), helper);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Installed helper escaped resources");
    files["installed-payload"] = await hashTree(resourceRoot);
    const executableRoot =
      target.platform === "darwin" ? join(target.app, "Contents/MacOS") : target.app;
    for (const name of (await readdir(executableRoot)).sort()) {
      if (name.endsWith(".exe") || target.platform === "darwin") {
        const file = join(executableRoot, name);
        if ((await lstat(file)).isFile())
          files["app-" + Object.keys(files).length] = await hashFile(file);
      }
    }
  } else if (process.platform === target.platform) {
    files["desktop-main"] = await hashFile(join(target.repo, "apps/desktop/dist-electron/main.js"));
    files["server-bundle"] = await hashFile(join(target.repo, "apps/server/dist/index.mjs"));
    // Hash the served client, including every JS/CSS asset, not only web/dist/index.html.
    files["served-client"] = await hashTree(join(target.repo, "apps/server/dist/client"));
    files["desktop-preload"] = await hashTree(join(target.repo, "apps/desktop/dist-electron"));
  }
  files["suite-source"] = await hashTree(join(target.repo, "scripts/computer-certification"));
  if (target.fixtureDirectory && process.platform === target.platform)
    files["prepared-fixtures"] = await hashTree(target.fixtureDirectory);
  files["electron-runner"] = await hashFile(
    join(target.repo, "apps/desktop/scripts/rehearse-computer-electron.mjs"),
  );
  files["native-fixtures"] = await hashTree(
    join(
      target.repo,
      "apps/desktop/native",
      target.platform === "darwin" ? "macos/Fixtures" : "windows/src",
    ),
  );
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: target.repo })).stdout.trim();
  const dirty = Boolean(
    (await exec("git", ["status", "--porcelain"], { cwd: target.repo })).stdout.trim(),
  );
  // A boolean dirty flag cannot detect edits made between two observations.
  // Pin tracked source changes, not just the compiled artifacts.
  files["tracked-code-diff"] = createHash("sha256")
    .update(
      (
        await exec("git", ["diff", "HEAD", "--binary", "--", ".", ":!docs"], {
          cwd: target.repo,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout,
    )
    .digest("hex");
  return {
    platform: target.platform,
    arch: target.arch ?? process.arch,
    commit,
    dirty,
    target: target.app ? "installed" : "development",
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))),
  };
}
export async function signature(path: string, platform: Platform): Promise<boolean> {
  if (process.platform !== platform) return false;
  try {
    if (platform === "darwin") {
      await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", resolve(path)], {
        timeout: 10000,
      });
      const details = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", resolve(path)], {
        timeout: 10000,
      });
      return /^TeamIdentifier=(?!not set)[^\r\n]+$/m.test(details.stderr);
    }
    await exec("signtool", ["verify", "/pa", resolve(path)], { timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
