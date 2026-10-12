import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { F5_PROTOCOL_VERSION, ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createRehearsalFixture } from "../src/computer/rehearsalFixture.ts";
import { rehearsalProviderErrorCodes } from "../src/computer/rehearsalElectronObservation.ts";

// Run with Bun, like the native rehearsals. The launched Electron app loads its
// actual compiled main/preload/renderer/server. No execution or consent shortcut.
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const output = arg("--output");
const sourceHome = arg("--codex-home");
const binary = arg("--codex-binary");
const statusOnly = args.includes("--status-only");
const controlsOnly = args.includes("--controls-only");
const actionsOnly = args.includes("--actions-only");
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_ELECTRON_REHEARSAL !== "1" ||
  !output ||
  !sourceHome ||
  !binary ||
  [statusOnly, controlsOnly, actionsOnly].filter(Boolean).length > 1
) {
  process.stderr.write(
    "Human coordination and real quota required: F5_COMPUTER_ELECTRON_REHEARSAL=1 bun apps/desktop/scripts/rehearse-computer-electron.mjs --codex-home <selected profile home> --codex-binary <path> --output <new report.json>\n",
  );
  process.exit(1);
}
const desktopDir =
  process.env.F5_REHEARSAL_DESKTOP_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Playwright's Electron launcher requires Node's child-process/debugger behavior.
// Bundle TS workspace dependencies for Node, leaving the production app untouched.
if (process.versions.bun) {
  const bootstrap = await mkdtemp(join(tmpdir(), "f5-electron-rehearsal-runner-"));
  try {
    const entry = join(bootstrap, "runner.mjs");
    await promisify(execFile)(
      "bun",
      [
        "build",
        fileURLToPath(import.meta.url),
        "--target=node",
        "--format=esm",
        `--outfile=${entry}`,
      ],
      { timeout: 30000 },
    );
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, F5_REHEARSAL_DESKTOP_ROOT: desktopDir },
      stdio: "inherit",
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const code = await new Promise((done, reject) => {
      child.once("exit", done);
      child.once("error", reject);
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.exitCode = code ?? 1;
  } finally {
    await rm(bootstrap, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}
await writeFile(resolve(output), "", { flag: "wx" });
const repo = resolve(desktopDir, "../..");
const requireWeb = createRequire(join(repo, "apps/web/package.json"));
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const { _electron } = requireWeb("playwright");
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-computer-electron-"));
const state = join(root, "app", "userdata");
const home = join(state, "provider-homes", "codex");
const workspace = join(root, "workspace");
const threadId = randomUUID();
const projectId = randomUUID();
const appId = `org.example.computer-rehearsal.${randomUUID()}`;
let application;
let page;
let fixture;
let interrupted = false;
let stage = "preparation";
let failureStage;
let permissionStatus;
let helperSha256;
let buildHashes;
let repositoryCommit;
let workingTreeDirty;
let nativeObservation;
let threadObservation;
let consentObservation;
let providerErrorCodes;
const checks = {};
const halt = () => {
  interrupted = true;
  if (page)
    void page
      .evaluate((id) => window.desktopBridge.computerAutomation.setPaused(id, true), threadId)
      .catch(() => {});
};
process.once("SIGINT", halt);
process.once("SIGTERM", halt);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(condition, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (interrupted || Date.now() > end) throw new Error("Rehearsal interrupted or timed out.");
    if (await condition()) {
      if (interrupted) throw new Error("Rehearsal interrupted.");
      return;
    }
    await delay(100);
  }
}
async function instructions(text) {
  process.stdout.write(`${text}\n`);
  await page.evaluate((value) => {
    let panel = document.getElementById("f5-computer-rehearsal-instructions");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "f5-computer-rehearsal-instructions";
      panel.style.cssText =
        "position:fixed;bottom:12px;right:12px;max-width:340px;padding:12px;background:#172554;color:white;border:2px solid #60a5fa;border-radius:8px;z-index:1000;font:14px system-ui;pointer-events:none";
      document.body.append(panel);
    }
    panel.textContent = value;
  }, text);
}
const rpc = (method, body = {}) =>
  page.evaluate(([name, input]) => window.__computerRehearsal.rpc(name, input), [method, body]);
const dispatch = (command) => {
  if (interrupted) throw new Error("Rehearsal interrupted.");
  return rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, {
    command: { commandId: randomUUID(), createdAt: new Date().toISOString(), ...command },
  });
};
const observer = () => application.evaluate(() => globalThis.__computerRehearsalNative.snapshot());
let previousTurnId;
let composerSubmissions = 0;
async function waitTurn() {
  await waitFor(async () => {
    const paused = await page.evaluate(() => window.__computerRehearsal.paused);
    if (paused) throw new Error("Physical input interrupted the active turn.");
    const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
    const turn = snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn;
    if (!turn || turn.turnId === previousTurnId) return false;
    if (turn?.state === "error" || turn?.state === "interrupted")
      throw new Error("Provider turn did not complete.");
    return turn?.state === "completed";
  }, 150000);
  await waitFor(async () => !(await observer()).held, 5000);
}
const modelSelection = {
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "low" }],
};
async function startTurn(text) {
  if (interrupted) throw new Error("Rehearsal interrupted.");
  const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
  previousTurnId = snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn?.turnId;
  await page.getByTestId("composer-editor").fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  composerSubmissions++;
}
try {
  repositoryCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  workingTreeDirty = Boolean(
    (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
  );
  helperSha256 = createHash("sha256")
    .update(await readFile(join(desktopDir, `dist-native/mac-${process.arch}/f5-computer-helper`)))
    .digest("hex");
  buildHashes = Object.fromEntries(
    await Promise.all(
      [
        ["desktopMain", join(desktopDir, "dist-electron/main.js")],
        ["serverBundle", join(repo, "apps/server/dist/index.mjs")],
        ["rendererIndex", join(repo, "apps/web/dist/index.html")],
        ["rehearsalSource", join(desktopDir, "scripts/rehearse-computer-electron.mjs")],
        ["observerSource", join(desktopDir, "src/computer/rehearsalElectronObservation.ts")],
        ["responseSource", join(desktopDir, "src/computer/rehearsalResponses.ts")],
      ].map(async ([name, path]) => [
        name,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  await mkdir(home, { recursive: true, mode: 0o700 });
  await copyFile(join(resolve(sourceHome), "auth.json"), join(home, "auth.json"));
  await chmod(join(home, "auth.json"), 0o600);
  await writeFile(
    join(home, "config.toml"),
    'cli_auth_credentials_store = "file"\n[features]\nplugins = false\n',
    { mode: 0o600 },
  );
  await mkdir(workspace);
  await exec("git", ["-c", "init.templateDir=", "init", "--initial-branch=main", workspace]);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "opencode", "grok", "antigravity"].map((id) => [
          id,
          { enabled: id === "codex" },
        ]),
      ),
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: resolve(binary), homePath: home },
        },
      },
      enableAgentComputerUse: true,
      computerUseBackend: "f5",
      enableProviderUpdateChecks: false,
      prHub: { pollIntervalSeconds: 0, discoverNotifications: false },
    }),
    { mode: 0o600 },
  );
  if (!statusOnly)
    fixture = await createRehearsalFixture({
      root,
      appId,
      expectedText: "F5_ELECTRON_REHEARSAL Ω🙂",
      sourceFile: join(desktopDir, "native/macos/Fixtures/ComputerControlFixture.swift"),
    });
  // Reuse the tested correlator at the actual inherited IPC boundary. Instrumentation
  // only observes; it does not supply results, grants, permits or consent answers.
  const compiledObserver = join(root, "response-observer.cjs");
  await exec(
    "bun",
    [
      "build",
      join(desktopDir, "src/computer/rehearsalElectronObservation.ts"),
      "--target=node",
      "--format=cjs",
      `--outfile=${compiledObserver}`,
    ],
    { timeout: 30000 },
  );
  const wrapper = join(root, "launch.cjs");
  await writeFile(
    wrapper,
    `
const {app}=require('electron');
const setPath=app.setPath.bind(app);
app.setPath=(key,value)=>setPath(key,key==='userData'?${JSON.stringify(join(root, "electron"))}:value);
const {ElectronRehearsalObservation}=require(${JSON.stringify(compiledObserver)});
const evidence=globalThis.__computerRehearsalNative=new ElectronRehearsalObservation();
const cp=require('node:child_process'),spawn=cp.spawn;
cp.spawn=function(...args){const child=spawn.apply(this,args);if(args[2]?.env?.F5_DESKTOP_COMPUTER_HOST==='ipc'){
child.on('message',m=>evidence.receive(m));
const send=child.send.bind(child);child.send=function(m,...args){evidence.receive(m);
return send(m,...args);};}return child;};
require(${JSON.stringify(join(desktopDir, "dist-electron/main.js"))});
`,
  );
  stage = "electron-launch";
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [wrapper],
    cwd: root,
    env: {
      HOME: process.env.HOME,
      USER: process.env.USER,
      PATH: process.env.PATH,
      F5_HOME: join(root, "app"),
      F5_COMPUTER_CONTROL_DEV: "1",
    },
    timeout: 60000,
  });
  application.process().stdout?.resume();
  application.process().stderr?.resume();
  page = await application.firstWindow({ timeout: 60000 });
  await page
    .getByRole("button", { name: "Add your first project", exact: true })
    .waitFor({ timeout: 60000 });
  stage = "computer-prerequisites";
  await waitFor(async () => {
    permissionStatus = await page.evaluate(() => window.desktopBridge.computerAutomation.status());
    if (
      !permissionStatus.available &&
      !["helper-missing", "monitor-unhealthy"].includes(permissionStatus.reason)
    )
      throw new Error("Computer prerequisites unavailable.");
    return permissionStatus.available;
  }, 10000);
  checks.realElectronPermissionsAvailable = true;
  stage = "renderer-transport";
  await page.evaluate(
    async ([protocol, fixtureAppId, rehearsalThreadId]) => {
      const state = (window.__computerRehearsal = {
        paused: false,
        consent: undefined,
        trustedConsent: false,
        trustedPause: false,
        trustedResume: false,
        activitySeen: false,
        thumbnailSeen: false,
        leaseSeen: false,
        consentSettled: false,
        consentAllowed: false,
        fixtureGranted: false,
      });
      const url = new URL(window.desktopBridge.getWsUrl());
      url.searchParams.set("protocol", String(protocol));
      const socket = new WebSocket(url);
      const pending = new Map();
      state.rpc = (method, body = {}) =>
        new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("RPC timed out"));
          }, 15000);
          pending.set(id, { resolve, reject, timer });
          socket.send(JSON.stringify({ id, body: { _tag: method, ...body } }));
        });
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id) {
          const item = pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(message.id);
            if (message.error) item.reject(new Error("RPC rejected"));
            else item.resolve(message.result);
          }
          return;
        }
        if (message.channel === "computer.access.requested") state.consent = message.data;
        if (
          message.channel === "computer.access.settled" &&
          message.data.requestId === state.consent?.requestId
        ) {
          state.consentSettled = true;
          state.consentAllowed = message.data.allowed === true;
        }
        if (
          message.channel === "computer.access.grantsChanged" &&
          message.data.threadId === rehearsalThreadId
        )
          state.fixtureGranted = message.data.grants.some((grant) => grant.appId === fixtureAppId);
        if (message.channel === "preview.automation.pauseChanged")
          state.paused = message.data.paused;
        if (message.channel === "agent.computerUseChanged" && message.data.threadId)
          state.leaseSeen = true;
        if (message.channel === "computer.activity") {
          state.activitySeen = true;
          state.thumbnailSeen ||=
            typeof message.data.thumbnailDataUrl === "string" &&
            message.data.thumbnailDataUrl.startsWith("data:image/jpeg;base64,") &&
            message.data.thumbnailDataUrl.length <= 40960;
        }
      };
      document.addEventListener(
        "click",
        (event) => {
          if (!event.isTrusted || !(event.target instanceof Element)) return;
          const button = event.target.closest("button");
          const name = button?.textContent?.trim();
          if (name === "Review access" && button?.closest('[data-testid="computer-access-card"]'))
            state.trustedConsent = true;
          if (name === "Pause") state.trustedPause = true;
          if (name === "Resume") state.trustedResume = true;
        },
        true,
      );
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("Connection failed"));
      });
    },
    [F5_PROTOCOL_VERSION, appId, threadId],
  );
  await dispatch({
    type: "project.create",
    projectId,
    title: "Computer rehearsal only",
    workspaceRoot: workspace,
    defaultModelSelection: modelSelection,
  });
  await dispatch({
    type: "thread.create",
    threadId,
    projectId,
    title: "F5 computer UI rehearsal",
    model: "gpt-6.1-sol",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  await page.evaluate((id) => {
    window.location.hash = `/${id}`;
  }, threadId);
  if (statusOnly) {
    stage = "read-only-status-turns";
    await instructions(
      "Read-only diagnostics: the provider will check computer status and list app metadata. No consent, screenshots or input are requested.",
    );
    for (let index = 0; index < 3; index++) {
      await startTurn(
        "Read-only F5 computer diagnostic. You may use tool discovery to locate F5's computer tools. Call computer_status once and computer_list_apps once. Report availability or a tagged error without app names. Do not request access, capture screenshots, use input, run commands, read files, or use tools beyond discovery and these two F5 tools.",
      );
      await waitTurn();
    }
    checks.readOnlyTurnsCompleted = composerSubmissions === 3;
    checks.noComputerLeaseAcquired = !(await observer()).leaseObserved;
    checks.threeCorrelatedMetadataResponses =
      (await observer()).operations.filter(
        (entry) => entry.op === "listApps" && entry.outcome === "ok" && entry.validApps === true,
      ).length === 3;
    stage = "finished";
  } else {
    stage = "human-consent-and-first-turn";
    await instructions(
      "Click Review access when the Computer access card appears, then approve only Computer Control Test Fixture in the native F5 dialog. Leave remembering off. Then keep mouse and keyboard idle until prompted.",
    );
    let overlayTimer;
    let overlayPoll = Promise.resolve();
    let overlayBusy = false;
    const overlay = {
      observed: false,
      protectedOptions: false,
      semanticOutline: false,
      coordinateCursor: false,
    };
    overlayTimer = setInterval(() => {
      if (overlayBusy) return;
      overlayBusy = true;
      overlayPoll = (async () => {
        const sample = await application.evaluate(async ({ BrowserWindow, screen }) => {
          const windows = BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().startsWith("data:text/html"),
          );
          let outline = false,
            point = false;
          for (const w of windows)
            if (w.isVisible()) {
              const value = await Promise.race([
                w.webContents
                  .executeJavaScript(
                    "({outline:!!document.getElementById('outline') && !document.getElementById('outline').hidden,point:document.getElementById('point')?.style.display==='block'})",
                  )
                  .catch(() => ({})),
                new Promise((done) => setTimeout(() => done({}), 200)),
              ]);
              outline ||= value.outline === true;
              point ||= value.point === true;
            }
          return {
            observed: windows.some((w) => w.isVisible()),
            protectedOptions:
              windows.length === screen.getAllDisplays().length &&
              windows.every(
                (w) =>
                  !w.isFocusable() &&
                  w.isAlwaysOnTop() &&
                  w.webContents.getLastWebPreferences().sandbox &&
                  w.webContents.getLastWebPreferences().contextIsolation &&
                  !w.webContents.getLastWebPreferences().nodeIntegration,
              ),
            outline,
            point,
          };
        });
        overlay.observed ||= sample.observed;
        overlay.protectedOptions ||= sample.protectedOptions;
        overlay.semanticOutline ||= sample.outline;
        overlay.coordinateCursor ||= sample.point;
        if (await page.getByTestId("computer-use-banner").isVisible())
          checks.realLeaseBannerVisible = true;
      })()
        .catch(() => {})
        .finally(() => {
          overlayBusy = false;
        });
    }, 100);
    try {
      await startTurn(
        `Explicitly authorized isolated F5 UI rehearsal. Use only F5 computer tools, only app ID ${appId}. This turn is for consent only: call computer_status, request access for that exact ID with reason Synthetic Electron UI rehearsal, then finish READY once access is allowed. Do not activate apps or execute input in this turn. Never use shell, files, network, any other app or the secure field. Stop immediately on any interruption, ambiguity or failure. The user will answer F5 consent manually.`,
      );
      await waitFor(
        async () => Boolean(await page.evaluate(() => window.__computerRehearsal.consent)),
        90000,
      );
      const requested = await page.evaluate(() => window.__computerRehearsal.consent);
      if (
        requested.kind !== "apps" ||
        requested.apps.length !== 1 ||
        requested.apps[0].appId !== appId
      )
        throw new Error("Unexpected access request.");
      checks.realConsentDialogVisible = await page.getByRole("dialog").isVisible();
      stage = "human-app-consent";
      await waitFor(async () => {
        const state = await page.evaluate(() => ({
          settled: window.__computerRehearsal.consentSettled,
          allowed: window.__computerRehearsal.consentAllowed,
          errorVisible: !!document.querySelector(
            '[data-testid="computer-access-card"] [role="alert"]',
          ),
        }));
        if (state.errorVisible || (state.settled && !state.allowed))
          throw new Error("Consent was rejected.");
        return state.settled && state.allowed;
      }, 90000);
      checks.realConsentSettledAllowed = true;
      stage = "consent-turn-completion";
      await waitTurn();
      checks.humanTrustedConsent = await page.evaluate(
        () => window.__computerRehearsal.trustedConsent,
      );
      checks.consentTurnEmittedNoInput =
        fixture.presses() === 0 && !fixture.typed() && !(await observer()).leaseObserved;
      if (!checks.humanTrustedConsent || !checks.consentTurnEmittedNoInput)
        throw new Error("Consent-only turn evidence incomplete.");
      await instructions(
        "Access confirmed. Keep mouse and keyboard idle; the agent will now use only the fixture.",
      );
      await delay(2000);
      stage = "first-action-turn";
      await startTurn(
        controlsOnly
          ? `Continue the isolated F5 UI controls check. Access was approved for exact app ${appId}; use only F5 computer tools for that app. Call computer_status, activate that app, take computer_screenshot, then finish READY. Do not inspect, click, type, send keys, scroll, drag or perform element actions. Never use shell, files, network or other apps. Stop immediately on any interruption, ambiguity or failed action.`
          : `Continue the isolated F5 UI rehearsal. Access was approved in the previous turn for exact app ${appId}; use only F5 computer tools for that app. You may use tool discovery to locate them. Call computer_status, activate it, take computer_screenshot, inspect it. Press Rehearsal press once using computer_element_action, focus Rehearsal input with an element action, and type exactly this synthetic text: F5_ELECTRON_REHEARSAL Ω🙂. Finish READY. Never use shell, files, network, any other app or the secure field. Stop immediately on any interruption, ambiguity or failed action.`,
      );
      await waitTurn();
      checks.humanTrustedConsent = await page.evaluate(
        () => window.__computerRehearsal.trustedConsent,
      );
      const first = await observer();
      if (controlsOnly) {
        checks.controlsFirstCaptureSucceeded = first.responses.nativeCaptureSucceeded;
        checks.controlsFirstActivationSucceeded = first.operations.some(
          (op) => op.op === "activateApp" && op.outcome === "ok",
        );
      } else {
        checks.firstTurnNativeResponses = Object.values(first.responses).every(Boolean);
        checks.fixtureReceivedOnePressAndUnicode = fixture.presses() === 1 && fixture.typed();
      }
      if (
        !checks.humanTrustedConsent ||
        (controlsOnly
          ? !checks.controlsFirstCaptureSucceeded || !checks.controlsFirstActivationSucceeded
          : !checks.firstTurnNativeResponses || !checks.fixtureReceivedOnePressAndUnicode)
      )
        throw new Error("First turn evidence incomplete.");
      if (!actionsOnly) {
        stage = "human-pause";
        checks.pauseControlVisibleAfterTurn = await page
          .getByTestId("computer-live-card")
          .getByRole("button", { name: "Pause", exact: true })
          .isVisible();
        if (!checks.pauseControlVisibleAfterTurn) throw new Error("Pause control was not visible.");
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().startsWith("t3:"))
            ?.focus(),
        );
        await instructions(
          "First turn finished. Click Pause in the Agent computer control card now.",
        );
        await waitFor(() => page.evaluate(() => window.__computerRehearsal.paused), 180000);
        checks.humanPauseMirrored =
          (await observer()).pauseObserved &&
          (await page.evaluate(() => window.__computerRehearsal.trustedPause));
        await delay(1500);
        checks.untrustedResumeRefused = await page.evaluate(async (id) => {
          try {
            await window.desktopBridge.computerAutomation.setPaused(id, false);
            return false;
          } catch {
            return true;
          }
        }, threadId);
        if (!checks.untrustedResumeRefused) throw new Error("Untrusted resume was accepted.");
        stage = "human-resume";
        await instructions(
          controlsOnly
            ? "Click Resume in the same card and confirm Resume in the native F5 dialog, then keep input idle. The agent will only activate the fixture and take a fresh screenshot."
            : "Click Resume in the same card and confirm Resume in the native F5 dialog, then keep mouse and keyboard idle. The agent will take a fresh screenshot and click the test button once.",
        );
        await waitFor(() => page.evaluate(() => !window.__computerRehearsal.paused), 180000);
        checks.humanResumeMirrored =
          (await observer()).resumeObserved &&
          (await page.evaluate(() => window.__computerRehearsal.trustedResume));
      }
      const before = await observer();
      await delay(2000);
      stage = actionsOnly ? "second-action-turn" : "second-turn-after-resume";
      await startTurn(
        controlsOnly
          ? `Continue this isolated F5 controls check. Use only F5 computer tools for exact app ${appId}. First computer_status; activate that app; take a NEW computer_screenshot, then finish READY. Do not inspect, click, type, send keys, scroll, drag or perform element actions. Never use shell, filesystem, network or other apps. Stop immediately on any failure or interruption; do not retry.`
          : `Continue this explicit isolated UI rehearsal. Use only F5 computer tools for exact app ${appId}; you may use tool discovery to locate them. First computer_status; activate the app; take a NEW computer_screenshot; inspect Rehearsal press and compute its center from its bounds. Use computer_click once at that center with the screenshot displayId. Never use a cached screenshot, element action for this click, shell, filesystem, network, other apps or the secure field. Finish READY. Stop immediately on any failure or interruption; do not retry.`,
      );
      await waitTurn();
      const after = await observer();
      checks[actionsOnly ? "freshCaptureOnNextTurn" : "freshCaptureAfterResume"] =
        after.captureResponses > before.captureResponses;
      if (controlsOnly)
        checks.controlsOnlyEmittedNoInput =
          fixture.presses() === 0 &&
          !fixture.typed() &&
          after.operations.every(
            (op) =>
              ![
                "inspect",
                "type",
                "key",
                "click",
                "move",
                "drag",
                "scroll",
                "elementAction",
              ].includes(op.op),
          );
      else checks.fixtureReceivedSecondCoordinatePress = fixture.presses() === 2;
      const visibleImage = page.getByAltText("Last captured computer action");
      checks.liveCardThumbnailRendered =
        (await visibleImage.isVisible()) &&
        (await visibleImage.evaluate((img) => img.complete && img.naturalWidth > 0));
      checks.realActivityAndThumbnailPush = await page.evaluate(
        () =>
          window.__computerRehearsal.activitySeen &&
          window.__computerRehearsal.thumbnailSeen &&
          window.__computerRehearsal.leaseSeen,
      );
      checks.turnLeaseReleased = !after.held && after.leaseObserved;
      checks.realComposerSubmittedAllThreeTurns = composerSubmissions === 3;
      clearInterval(overlayTimer);
      await Promise.race([overlayPoll, delay(1000)]);
      checks.realOverlayObserved = overlay.observed && overlay.protectedOptions;
      if (!controlsOnly) {
        checks.realSemanticOutlineObserved = overlay.semanticOutline;
        checks.realCoordinateCursorObserved = overlay.coordinateCursor;
      }
      checks.overlayClosedAfterLease = await application.evaluate(
        ({ BrowserWindow }) =>
          !BrowserWindow.getAllWindows().some((w) =>
            w.webContents.getURL().startsWith("data:text/html"),
          ),
      );
      stage = "finished";
      await instructions("Check finished. You can use your computer again.");
    } finally {
      clearInterval(overlayTimer);
      await Promise.race([overlayPoll, delay(1000)]);
    }
  }
} catch {
  failureStage = stage;
  process.exitCode = 1;
} finally {
  process.off("SIGINT", halt);
  process.off("SIGTERM", halt);
  if (application) nativeObservation = await observer().catch(() => undefined);
  if (page && application) {
    const tail = await rpc(ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
      threadId,
      messageLimit: 0,
      checkpointLimit: 0,
      activityLimit: 100,
    }).catch(() => undefined);
    providerErrorCodes = rehearsalProviderErrorCodes(tail?.activities);
    if (statusOnly) {
      checks.noTaggedProviderErrors = providerErrorCodes.length === 0;
      checks.hostAvailableAtEnd = nativeObservation?.hostStatus?.available === true;
    }
    consentObservation = await page
      .evaluate(() => {
        const state = window.__computerRehearsal;
        return {
          requested: !!state?.consent,
          trustedClick: state?.trustedConsent === true,
          settled: state?.consentSettled === true,
          allowed: state?.consentAllowed === true,
          fixtureGranted: state?.fixtureGranted === true,
          cardHasError: !!document.querySelector(
            '[data-testid="computer-access-card"] [role="alert"]',
          ),
          dialogPresentInDom: !!document.querySelector('[role="dialog"]'),
        };
      })
      .catch(() => undefined);
    if (statusOnly) checks.noConsentRequested = consentObservation?.requested === false;
    threadObservation = await page
      .evaluate(
        async ([method, id]) => {
          const snapshot = await window.__computerRehearsal.rpc(method);
          const thread = snapshot.threads.find((entry) => entry.id === id);
          if (!thread) return { found: false };
          const modes = ["full-access", "approval-required"];
          const interactions = ["default", "plan"];
          const turnStates = ["running", "completed", "interrupted", "error"];
          return {
            found: true,
            runtimeMode: modes.includes(thread.runtimeMode) ? thread.runtimeMode : "unknown",
            sessionRuntimeMode: modes.includes(thread.session?.runtimeMode)
              ? thread.session.runtimeMode
              : "unknown",
            interactionMode: interactions.includes(thread.interactionMode)
              ? thread.interactionMode
              : "unknown",
            turnState: turnStates.includes(thread.latestTurn?.state)
              ? thread.latestTurn.state
              : "unknown",
            pendingUserInputs: Math.min(100, thread.pendingUserInputs?.length ?? 0),
          };
        },
        [ORCHESTRATION_WS_METHODS.getSnapshot, threadId],
      )
      .catch(() => undefined);
  }
  if (page)
    await page
      .evaluate((id) => window.desktopBridge.computerAutomation.setPaused(id, true), threadId)
      .catch(() => {});
  if (application) await application.close().catch(() => {});
  fixture?.child.kill();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const passed = !failureStage && !interrupted && Object.values(checks).every(Boolean);
  if (!passed) process.exitCode = 1;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        scope: statusOnly
          ? "unsigned-real-electron-codex-read-only-discovery-diagnostic"
          : controlsOnly
            ? "unsigned-real-electron-codex-human-consent-and-controls"
            : actionsOnly
              ? "unsigned-real-electron-codex-human-consent-and-actions"
              : "unsigned-real-electron-codex-human-consent-synthetic-app",
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        repositoryCommit,
        workingTreeDirty,
        helperSha256,
        buildHashes,
        signed: false,
        certified: false,
        provider: "codex",
        runtimeMode: "full-access",
        state: passed ? "passed" : "failed",
        interrupted,
        ...(failureStage ? { failureStage } : {}),
        permissionStatus,
        nativeObservation,
        threadObservation,
        consentObservation,
        providerErrorCodes,
        checks,
        ...(controlsOnly ? { controlsOnly: true } : {}),
        ...(actionsOnly ? { actionsOnly: true } : {}),
        limitations: [
          ...(statusOnly
            ? [
                "Read-only tool discovery/status/app metadata only; no consent, screenshots, OS input or human controls tested",
              ]
            : [
                "One real provider and one synthetic AppKit app, on the current display only",
                actionsOnly
                  ? "Human app consent; Pause/Resume is excluded from this actions-only run"
                  : "Human app consent and pause/resume; no session-actions consent in full-access mode",
                ...(actionsOnly ? ["No session-actions consent in full-access mode"] : []),
                ...(controlsOnly
                  ? [
                      "Controls-only check: no inspection, pointer/keyboard/semantic input or coordinate/element overlay proof",
                    ]
                  : []),
              ]),
          "No installed-build TCC attribution, signed packaging, real-app or multi-profile/display certification",
          "Overlay capture exclusion, hung-renderer/host stop latency, Stop interruption and Windows runtime remain pending",
          "Provider built-in and Chrome gates remain closed; no image bytes, typed values, accessibility content or raw errors retained",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Electron rehearsal: ${resolve(output)} (${passed ? "passed" : "failed"}; release gates unchanged).\n`,
  );
}
