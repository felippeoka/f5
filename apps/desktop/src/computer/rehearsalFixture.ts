import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** A temporary app containing synthetic content only; never adopts a user app. */
export async function createRehearsalFixture(options: {
  root: string;
  appId: string;
  ungranted?: boolean;
  background?: boolean;
  displayId?: string;
  executableSource?: string;
  expectedText?: string;
  sourceFile?: string;
  observeChord?: boolean;
}) {
  if (options.displayId !== undefined && !/^\d{1,10}$/.test(options.displayId))
    throw new Error("Invalid fixture display id.");
  const contents = join(options.root, options.appId, "Fixture.app", "Contents");
  const executable = join(contents, "MacOS", "Fixture");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${options.appId}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Computer Control Test Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`,
  );
  if (options.executableSource) await copyFile(options.executableSource, executable);
  else
    await promisify(execFile)(
      "swiftc",
      [
        "-framework",
        "AppKit",
        options.sourceFile ??
          resolve(import.meta.dirname, "../../native/macos/Fixtures/ComputerControlFixture.swift"),
        "-o",
        executable,
      ],
      { timeout: 30000 },
    );
  const args = [
    ...(options.background ? ["--background"] : []),
    ...(options.displayId ? ["--display-id", options.displayId] : []),
    ...(options.ungranted ? ["--ungranted"] : []),
    ...(options.expectedText ? ["--expected-text", options.expectedText] : []),
    ...(options.observeChord ? ["--observe-chord"] : []),
  ];
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"] });
  let presses = 0;
  let typed = false;
  let buffer = "";
  const ready = new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic fixture startup timed out.")), 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic fixture exited before becoming ready."));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === "FIXTURE_READY") {
          clearTimeout(timer);
          done();
        } else if (line === "FIXTURE_PRESSED") presses++;
        else if (line === "FIXTURE_TYPED") typed = true;
      }
    });
  });
  try {
    await ready;
  } catch (error) {
    child.kill();
    throw error;
  }
  return { child, executable, presses: () => presses, typed: () => typed };
}
