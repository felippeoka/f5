import { spawn } from "node:child_process";
import { cp, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { observeRehearsalFixture } from "./rehearsalFixture";

export const CHROMIUM_FIXTURE_BUNDLE = "ChromiumFixture.app";
export function decodeChromiumFixture(value: unknown): { appId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("bundle" in value) ||
    value.bundle !== CHROMIUM_FIXTURE_BUNDLE ||
    !("appId" in value) ||
    typeof value.appId !== "string" ||
    !/^org\.example\.chromium-computer-fixture\.[a-f0-9-]{36}$/.test(value.appId)
  )
    throw new Error("Invalid Chromium fixture metadata.");
  return { appId: value.appId };
}
export async function readChromiumFixture(directory: string) {
  const metadata = decodeChromiumFixture(
    JSON.parse(await readFile(join(directory, "electron-fixture.json"), "utf8")),
  );
  const root = await realpath(directory);
  const bundle = await realpath(join(root, CHROMIUM_FIXTURE_BUNDLE));
  const rel = relative(root, bundle);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Chromium fixture escaped preparation directory.");
  return { ...metadata, bundle };
}

/** Runs a private copy, keeping the prepared/pinned artifact immutable. No
 * grants, execution permits, consent answers or native messages are exposed. */
export async function createRehearsalChromiumFixture(options: {
  root: string;
  preparedDirectory: string;
  appId: string;
}) {
  if (process.platform !== "darwin") throw new Error("Chromium fixture platform unavailable.");
  const prepared = await readChromiumFixture(options.preparedDirectory);
  if (prepared.appId !== options.appId) throw new Error("Chromium fixture identity changed.");
  const bundle = join(options.root, CHROMIUM_FIXTURE_BUNDLE);
  await cp(prepared.bundle, bundle, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  const executable = join(bundle, "Contents/MacOS/Electron");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(executable, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  // Runtime diagnostics never become receipts or persisted app content.
  child.stderr.resume();
  return observeRehearsalFixture(child, executable);
}
