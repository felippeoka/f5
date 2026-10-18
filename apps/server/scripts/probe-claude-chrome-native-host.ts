/** Discovery only. Network and writes outside a throwaway HOME are denied on macOS. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import path from "node:path";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable";

const browsers = [
  "Google/Chrome",
  "Google/Chrome Beta",
  "Google/Chrome Canary",
  "Chromium",
  "Microsoft Edge",
  "BraveSoftware/Brave-Browser",
  "Arc/User Data",
  "Vivaldi",
];
const directories = (home: string) =>
  browsers.map((browser) =>
    path.join(home, "Library/Application Support", browser, "NativeMessagingHosts"),
  );
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    )) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        files[file] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
      else files[file] = "non-regular-file";
    }
  };
  await visit(root);
  return files;
}
async function hostSnapshot(home: string) {
  return Object.assign({}, ...(await Promise.all(directories(home).map(snapshot)))) as Record<
    string,
    string
  >;
}
const outputArg = process.argv.indexOf("--output");
const reportPath = process.argv[outputArg + 1];
if (process.platform !== "darwin" || outputArg < 0 || !reportPath)
  throw new Error("Use on macOS with --output <report.json>.");
const executable = resolveBundledClaudeExecutable();
const hash = createHash("sha256");
for await (const chunk of createReadStream(executable)) hash.update(chunk);
const executableSha256 = hash.digest("hex");
const sdk = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  .dependencies["@anthropic-ai/claude-agent-sdk"];
const temporary = await mkdtemp(path.join(tmpdir(), "f5-chrome-discovery-"));
const home = path.join(temporary, "home");
const scratch = path.join(temporary, "scratch");
await mkdir(scratch, { mode: 0o700 });
const providerHome = path.join(home, ".claude");
await mkdir(providerHome, { recursive: true, mode: 0o700 });
const operatorHome = userInfo().homedir;
const operatorBefore = await hostSnapshot(operatorHome);
const before = await snapshot(temporary);
const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(temporary)}) (literal "/dev/null"))`;
let exitCode: number | null = null;
let failure: string | undefined;
let diagnostic = "";
await new Promise<void>((resolve) => {
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      profile,
      executable,
      "--chrome",
      "--print",
      "--no-session-persistence",
      "Reply OK without using tools.",
    ],
    {
      cwd: home,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: providerHome,
        XDG_CONFIG_HOME: path.join(providerHome, "config"),
        XDG_CACHE_HOME: path.join(providerHome, "cache"),
        TMPDIR: scratch,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString("utf8")).slice(-16_384);
  });
  const timer = setTimeout(() => {
    failure = "setup-timeout";
    child.kill("SIGTERM");
  }, 15_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 17_000);
  child.on("error", () => {
    failure = "launch-failed";
    clearTimeout(timer);
    clearTimeout(kill);
    resolve();
  });
  child.on("close", (code) => {
    exitCode = code;
    if (/sandbox.*(?:denied|not permitted)/i.test(diagnostic)) failure = "sandbox-denied";
    clearTimeout(timer);
    clearTimeout(kill);
    resolve();
  });
});
const after = await snapshot(temporary);
const operatorAfter = await hostSnapshot(operatorHome);
const changed = Object.keys(after).filter((file) => before[file] !== after[file]);
const allowed = directories(home);
const outside = changed.filter(
  (file) =>
    !file.startsWith(providerHome + path.sep) &&
    !file.startsWith(scratch + path.sep) &&
    !allowed.some((directory) => file.startsWith(directory + path.sep)),
);
const registrations = [];
for (const file of changed.filter((file) =>
  allowed.some((directory) => file.startsWith(directory + path.sep)),
)) {
  try {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    registrations.push({
      location: path.relative(temporary, file),
      name: manifest.name,
      target: manifest.path,
      allowed_origins: manifest.allowed_origins,
    });
  } catch {
    registrations.push({ location: path.relative(temporary, file), error: "manifest-unreadable" });
  }
}
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  sdkVersion: sdk,
  executableSha256,
  executableBytes: (await stat(executable)).size,
  temporary,
  exitCode,
  ...(failure
    ? {
        failure,
        diagnostic: diagnostic
          .replaceAll(temporary, "<temporary>")
          .replaceAll(operatorHome, "<operator-home>")
          .slice(-2048),
      }
    : {}),
  operatorRegistrationsUnchanged: JSON.stringify(operatorBefore) === JSON.stringify(operatorAfter),
  changed: changed.map((file) => path.relative(temporary, file)),
  outsideTransactionLocations: outside.map((file) => path.relative(temporary, file)),
  registrations,
  serverStatus: "not-reachable-without-authentication",
  candidateReady:
    !failure &&
    outside.length === 0 &&
    registrations.length > 0 &&
    JSON.stringify(operatorBefore) === JSON.stringify(operatorAfter),
};
await writeFile(path.resolve(reportPath), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({
    report: path.resolve(reportPath),
    candidateReady: report.candidateReady,
    registrations: registrations.length,
    failure,
  }) + "\n",
);
