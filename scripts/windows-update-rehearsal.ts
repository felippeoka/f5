// @effect-diagnostics nodeBuiltinImport:off
/**
 * Installs an unpublished baseline build on a fresh Windows runner, points the
 * installation at a loopback GitHub emulator and drives the real updater through
 * the renderer bridge (Chromium remote debugging; Node inspector fuses stay off).
 * Usage: node scripts/windows-update-rehearsal.ts --baseline-dir D --target-dir D
 *   --baseline V --target V [--log-dir D]
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { parseAppUpdateConfig } from "./lib/app-update-config.ts";
import {
  rehearsalAppUpdateConfig,
  startUpdateFeedEmulator,
  type FeedMode,
} from "./lib/update-rehearsal.ts";

if (process.platform !== "win32") throw new Error("The update rehearsal runs on Windows only");
const { values } = parseArgs({
  options: {
    "baseline-dir": { type: "string" },
    "target-dir": { type: "string" },
    baseline: { type: "string" },
    target: { type: "string" },
    "log-dir": { type: "string", default: "rehearsal-logs" },
  },
});
const baseline = values.baseline!;
const target = values.target!;
if (!baseline || !target || !values["baseline-dir"] || !values["target-dir"])
  throw new Error("Usage: --baseline-dir D --target-dir D --baseline V --target V");
const logDir = values["log-dir"]!;
mkdirSync(logDir, { recursive: true });

const appData = process.env.APPDATA!;
const localAppData = process.env.LOCALAPPDATA!;
const userData = join(appData, "f5");
const stateDir = join(homedir(), ".f5");
const startMenuShortcut = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "F5.lnk");
const debugPort = 9333;
const step = (message: string) => console.log(`[rehearsal] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function powershell(script: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

interface UninstallEntry {
  readonly DisplayName: string;
  readonly DisplayVersion: string;
  readonly UninstallString: string;
  readonly PSPath: string;
}
function uninstallEntry(): UninstallEntry | null {
  const json = powershell(
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^F5( \\d|$)' } | Select-Object DisplayName,DisplayVersion,UninstallString,PSPath | ConvertTo-Json -Compress",
  );
  if (!json) return null;
  const parsed = JSON.parse(json) as UninstallEntry | UninstallEntry[];
  if (Array.isArray(parsed)) throw new Error("More than one F5 installation is registered");
  return parsed;
}
function installDirectory(entry: UninstallEntry): string {
  const match = /^"([^"]+)"/.exec(entry.UninstallString);
  assert(match, `Unexpected UninstallString: ${entry.UninstallString}`);
  return dirname(match[1]!);
}

/** Inherited environment without Node/Bun on PATH or ambient F5/provider configuration. */
function applicationEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      !/^(F5_|T3CODE_|VITE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|ELECTRON_|NODE_|BUN_|npm_)/i.test(
        key,
      ) &&
      !/TOKEN|API_KEY/i.test(key)
    )
      env[key] = value;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  env[pathKey] = entries
    .filter(
      (dir) =>
        !["node.exe", "bun.exe", "node.cmd", "bun.cmd"].some((exe) => existsSync(join(dir, exe))),
    )
    .join(delimiter);
  for (const dir of env[pathKey]!.split(delimiter))
    for (const exe of ["node.exe", "bun.exe"])
      assert(!existsSync(join(dir, exe)), `${exe} is still on the application PATH`);
  env.F5_SKIP_USERDATA_IMPORT = "1";
  return env;
}

let app: ChildProcess | null = null;
function launch(exe: string, name: string): void {
  const log = createWriteStream(join(logDir, `${name}.log`));
  app = spawn(exe, [`--remote-debugging-port=${debugPort}`], {
    env: applicationEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.pipe(log);
  app.stderr?.pipe(log);
}
function stopApplication(): void {
  spawnSync("taskkill.exe", ["/IM", "F5.exe", "/T", "/F"], { stdio: "ignore" });
  app = null;
}
function f5Running(): boolean {
  return /F5\.exe/i.test(
    execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq F5.exe", "/NH"], { encoding: "utf8" }),
  );
}

/** Evaluates an expression in the F5 renderer that exposes `desktopBridge`. */
async function evaluate<T>(expression: string): Promise<T> {
  const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  for (const target of targets.filter((entry) => entry.type === "page")) {
    const result = await new Promise<{ ok: boolean; value?: T; error?: string }>(
      (resolve, reject) => {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("CDP evaluation timed out"));
        }, 600_000);
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        };
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression: `(async () => { if (!window.desktopBridge?.getUpdateState) return { ok: false }; return { ok: true, value: await (${expression}) }; })()`,
                awaitPromise: true,
                returnByValue: true,
              },
            }),
          );
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            id?: number;
            result?: {
              result?: { value?: { ok: boolean; value?: T } };
              exceptionDetails?: { text: string; exception?: { description?: string } };
            };
          };
          if (message.id !== 1) return;
          clearTimeout(timer);
          socket.close();
          const details = message.result?.exceptionDetails;
          if (details) resolve({ ok: true, error: details.exception?.description ?? details.text });
          else resolve(message.result?.result?.value ?? { ok: false });
        };
      },
    );
    if (result.error) throw new Error(result.error);
    if (result.ok) return result.value as T;
  }
  throw new Error("No renderer exposes desktopBridge yet");
}
const state = () => evaluate<DesktopUpdateState>("window.desktopBridge.getUpdateState()");
const settled = (label: string, busy: readonly string[]) =>
  waitFor(
    label,
    async () => {
      const current = await state();
      return busy.includes(current.status) ? undefined : current;
    },
    300_000,
  );

async function check(mode: FeedMode): Promise<DesktopUpdateState> {
  feed.setMode(mode);
  await waitFor("an accepted update check", async () => {
    await settled("idle updater", ["checking", "downloading", "preparing"]);
    const result = await evaluate<{ accepted: boolean } | null>(
      "window.desktopBridge.checkForUpdates().catch(() => null)",
    );
    return result?.accepted ? true : undefined;
  });
  return settled(`${mode} check`, ["checking"]);
}
async function download(mode: FeedMode): Promise<DesktopUpdateState> {
  feed.setMode(mode);
  await evaluate("window.desktopBridge.downloadUpdate().catch(() => null)");
  return settled(`${mode} download`, ["downloading"]);
}
/** Starts installation without awaiting it; the native confirmation blocks the IPC call. */
async function requestInstall(): Promise<void> {
  await evaluate("(window.desktopBridge.installUpdate().catch(() => null), true)");
}
/** Invokes a button in a native dialog owned by an F5 process via UI Automation. */
function pressDialogButton(name: string): void {
  powershell(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $ids = @(Get-Process -Name F5 -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  foreach ($window in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($ids -notcontains $window.Current.ProcessId) { continue }
    foreach ($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
      if ($button.Current.Name -like '${name}*') {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 500
}
throw 'Dialog button not found: ${name}'
`);
}

function listFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(root, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

const artifact = (dir: string, version: string, suffix = "") =>
  join(dir, `F5-${version}-x64.exe${suffix}`);
const baselineDir = values["baseline-dir"]!;
const targetDir = values["target-dir"]!;
const feed = await startUpdateFeedEmulator({
  latest: target,
  releases: [
    {
      version: baseline,
      assets: {
        [`F5-${baseline}-x64.exe`]: artifact(baselineDir, baseline),
        [`F5-${baseline}-x64.exe.blockmap`]: artifact(baselineDir, baseline, ".blockmap"),
        "latest.yml": join(baselineDir, "latest.yml"),
      },
    },
    {
      version: target,
      assets: {
        [`F5-${target}-x64.exe`]: artifact(targetDir, target),
        [`F5-${target}-x64.exe.blockmap`]: artifact(targetDir, target, ".blockmap"),
        "latest.yml": join(targetDir, "latest.yml"),
      },
    },
  ],
});

try {
  assert(uninstallEntry() === null, "F5 is already installed on this runner");
  step("Seeding profile data");
  mkdirSync(join(stateDir, "userdata"), { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    join(stateDir, "userdata", "settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        ["codex", "claude", "cursor", "opencode", "grok"].map((id) => [id, { enabled: false }]),
      ),
      prHub: { pollIntervalSeconds: 0, discoverNotifications: false },
    }),
  );
  writeFileSync(join(stateDir, "rehearsal-marker"), baseline);
  writeFileSync(join(userData, "rehearsal-marker"), baseline);

  step(`Installing ${baseline} silently`);
  const install = spawnSync(artifact(baselineDir, baseline), ["/S"], { timeout: 300_000 });
  assert(install.status === 0, `Baseline installer exited with ${install.status}`);
  const installed = await waitFor("baseline registration", () => uninstallEntry() ?? undefined);
  assert(installed.DisplayVersion === baseline, `Installed ${installed.DisplayVersion}`);
  const dir = installDirectory(installed);
  const exe = join(dir, "F5.exe");
  assert(existsSync(exe), `Missing ${exe}`);
  assert(existsSync(startMenuShortcut), "Missing Start Menu shortcut after install");
  const appUpdatePath = join(dir, "resources", "app-update.yml");
  const productionFeed = readFileSync(appUpdatePath, "utf8");
  assert(
    !("publisherName" in parseAppUpdateConfig(productionFeed)),
    "Unsigned build has publisherName",
  );
  const cacheDirName = parseAppUpdateConfig(productionFeed).updaterCacheDirName;
  assert(typeof cacheDirName === "string", "app-update.yml lacks updaterCacheDirName");
  writeFileSync(appUpdatePath, rehearsalAppUpdateConfig(productionFeed, feed.port));

  step("Launching baseline without Node/Bun on PATH");
  feed.setMode("offline");
  launch(exe, "baseline");
  const initial = await waitFor("renderer bridge", () => state(), 180_000);
  assert(initial.enabled, `Updates disabled: ${initial.message}`);
  assert(initial.currentVersion === baseline, `Running ${initial.currentVersion}`);
  assert(initial.channel === "stable", `Channel ${initial.channel}`);
  // Let the 15-second startup check run (offline) so it cannot race the steps below.
  await sleep(20_000);
  const seededFiles = listFiles(join(stateDir, "userdata"));

  step("Offline check reports a retryable check error");
  const offline = await check("offline");
  assert(offline.status === "error" && offline.errorContext === "check", JSON.stringify(offline));

  step("Corrupt sha512 is rejected");
  const corruptCheck = await check("corrupt-manifest");
  assert(
    corruptCheck.status === "available" && corruptCheck.availableVersion === target,
    JSON.stringify(corruptCheck),
  );
  const corrupt = await download("corrupt-manifest");
  assert(corrupt.errorContext === "download" && corrupt.canRetry, JSON.stringify(corrupt));
  assert(corrupt.downloadedVersion === null, "Corrupt download was accepted");

  step("Interrupted download is retryable");
  assert((await check("normal")).status === "available", "Update not offered");
  const dropped = await download("drop-installer");
  assert(dropped.errorContext === "download" && dropped.canRetry, JSON.stringify(dropped));
  const downloaded = await download("normal");
  assert(
    downloaded.status === "downloaded" && downloaded.downloadedVersion === target,
    JSON.stringify(downloaded),
  );

  step("Cancelling the restart confirmation keeps F5 running");
  await requestInstall();
  pressDialogButton("Cancel");
  // The installer phase returns to idle asynchronously after the dialog closes.
  await sleep(3_000);
  const cancelled = await settled("cancelled install", ["preparing"]);
  assert(
    cancelled.status === "downloaded" && cancelled.errorContext !== "install",
    JSON.stringify(cancelled),
  );

  step("Installer launch failure recovers windows and stays retryable");
  const pending = join(localAppData, cacheDirName, "pending");
  const installer = readdirSync(pending).find((name) => name.toLowerCase().endsWith(".exe"));
  assert(installer, `No pending installer in ${pending}`);
  const stash = join(logDir, installer);
  renameSync(join(pending, installer), stash);
  await requestInstall();
  pressDialogButton("Restart to update");
  const failed = await waitFor(
    "install failure recovery",
    async () => {
      const current = await state();
      return current.errorContext === "install" ? current : undefined;
    },
    180_000,
  );
  assert(failed.status === "downloaded" && failed.canRetry, JSON.stringify(failed));
  copyFileSync(stash, join(pending, installer));

  step(`Restarting into ${target}`);
  await requestInstall();
  pressDialogButton("Restart to update");
  await waitFor("baseline exit", () => (f5Running() ? undefined : true), 120_000).catch(() => {
    // The relaunched target may already be running; version checks below decide.
  });
  const upgraded = await waitFor(
    "target registration",
    () => (uninstallEntry()?.DisplayVersion === target ? true : undefined),
    300_000,
  );
  assert(upgraded, "Upgrade did not register");
  await waitFor("target relaunch", () => (f5Running() ? true : undefined), 120_000);
  stopApplication();
  assert(existsSync(startMenuShortcut), "Start Menu shortcut missing after upgrade");
  assert(installDirectory(uninstallEntry()!) === dir, "Upgrade changed the installation directory");
  for (const marker of [join(stateDir, "rehearsal-marker"), join(userData, "rehearsal-marker")])
    assert(readFileSync(marker, "utf8") === baseline, `Profile marker changed: ${marker}`);
  const settings = JSON.parse(readFileSync(join(stateDir, "userdata", "settings.json"), "utf8"));
  assert(settings.providers?.codex?.enabled === false, "Settings were not preserved");
  const remaining = new Set(listFiles(join(stateDir, "userdata")));
  // Logs rotate and SQLite sidecars come and go; durable profile files must remain.
  const transient = /(^|\/)logs?\/|\.log(\.\d+)?$|-(journal|wal|shm)$|\.tmp$/i;
  for (const file of seededFiles)
    if (!transient.test(file))
      assert(remaining.has(file), `Profile file lost during upgrade: ${file}`);

  step("Relaunching the upgraded build");
  writeFileSync(
    join(dir, "resources", "app-update.yml"),
    rehearsalAppUpdateConfig(
      readFileSync(join(dir, "resources", "app-update.yml"), "utf8"),
      feed.port,
    ),
  );
  launch(exe, "target");
  const relaunched = await waitFor("upgraded renderer bridge", () => state(), 180_000);
  assert(relaunched.currentVersion === target, `Running ${relaunched.currentVersion}`);
  const upToDate = await check("normal");
  assert(upToDate.status === "up-to-date", JSON.stringify(upToDate));
  stopApplication();

  step("Uninstalling silently");
  const entry = uninstallEntry()!;
  const uninstaller = /^"([^"]+)"(.*)$/.exec(entry.UninstallString)!;
  spawnSync(uninstaller[1]!, [...uninstaller[2]!.trim().split(/\s+/).filter(Boolean), "/S"], {
    timeout: 300_000,
  });
  await waitFor(
    "uninstall",
    () => (uninstallEntry() === null && !existsSync(exe) ? true : undefined),
    300_000,
  );
  assert(!existsSync(startMenuShortcut), "Start Menu shortcut remains after uninstall");
  for (const marker of [join(stateDir, "rehearsal-marker"), join(userData, "rehearsal-marker")])
    assert(existsSync(marker), `Uninstall removed user data: ${marker}`);
  step("Windows update rehearsal passed");
} finally {
  if (app) stopApplication();
  writeFileSync(join(logDir, "feed-requests.log"), feed.requests.join("\n") + "\n");
  await feed.close();
}
