import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Target } from "./identity";
import { cleanEnvironment } from "./process";

export const FIXTURE_NAMES = [
  "ComputerControlFixture",
  "StopLatencyFixture",
  "CaptureVerifier",
  "ProtectionAppVerifier",
  "RealAppVerifier",
] as const;
/** Compile once before readiness. Never starts an app, grant, permit or input. */
export async function prepareFixtures(target: Target, directory: string): Promise<boolean> {
  if (process.platform !== "darwin" || target.platform !== "darwin") return false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const exec = promisify(execFile);
  for (const name of FIXTURE_NAMES) {
    const output = join(directory, name);
    let exists = true;
    try {
      await access(output);
    } catch {
      exists = false;
    }
    if (exists) throw new Error("Fixture output already exists; choose a new suite directory");
    try {
      await exec(
        "swiftc",
        [
          "-framework",
          "AppKit",
          join(target.repo, "apps/desktop/native/macos/Fixtures", name + ".swift"),
          "-o",
          output,
        ],
        { env: cleanEnvironment(), timeout: 30000, maxBuffer: 16384 },
      );
    } catch {
      return false;
    }
  }
  return true;
}
