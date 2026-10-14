import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const requireWeb = createRequire(resolve(desktopDir, "../web/package.json"));
const { _electron } = requireWeb("playwright");
const directory = mkdtempSync(join(tmpdir(), "f5-desktop-smoke-"));
const overlayModule = join(directory, "computer-overlay.cjs");
if (process.platform === "darwin") {
  execFileSync(
    "bun",
    [
      "build",
      join(desktopDir, "src/computer/ComputerOverlay.ts"),
      "--target=node",
      "--format=cjs",
      "--external=electron",
      "--outfile",
      overlayModule,
    ],
    { cwd: desktopDir, stdio: "pipe" },
  );
}
const state = join(directory, "app", "userdata");
mkdirSync(state, { recursive: true });
writeFileSync(
  join(state, "settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(
      ["codex", "claude", "cursor", "opencode", "grok"].map((id) => [id, { enabled: false }]),
    ),
    prHub: { pollIntervalSeconds: 0, discoverNotifications: false },
  }),
);
// Main sets userData itself. Redirect that assignment before it takes the instance lock.
const wrapper = join(directory, "launch.cjs");
writeFileSync(
  wrapper,
  `const {app}=require("electron");
const setPath=app.setPath.bind(app);
app.setPath=(key,value)=>setPath(key,key==='userData'?${JSON.stringify(join(directory, "electron"))}:value);
require(${JSON.stringify(join(desktopDir, "dist-electron/main.js"))});
`,
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(F5_|T3CODE_|VITE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|ELECTRON_)/.test(key) &&
      !/TOKEN|API_KEY/.test(key),
  ),
);
env.F5_HOME = join(directory, "app");
let application;
let electronProcess;
let output = "";
try {
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [wrapper],
    cwd: directory,
    env,
    timeout: 60_000,
  });
  electronProcess = application.process();
  for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
    stream?.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65_536);
    });
  }
  let page = await application.firstWindow({ timeout: 60_000 });
  const errors = [];
  page.on("requestfailed", (request) =>
    console.error(
      "Smoke request failure:",
      new URL(request.url()).pathname,
      request.failure()?.errorText,
    ),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error(
        "Smoke renderer error:",
        message.text().replace(/token=[^&\s']+/gu, "token=REDACTED"),
      );
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Positive evidence: bundled renderer and its authenticated server connection both work.
  await page
    .getByRole("button", { name: "Add your first project", exact: true })
    .waitFor({ timeout: 60_000 });
  // The renderer can become ready before Electron shows its native surface.
  // Capturing that hidden surface under Xvfb can fail with a zero-width bitmap.
  await page.waitForFunction(
    () => document.visibilityState === "visible" && innerWidth > 0 && innerHeight > 0,
    undefined,
    { timeout: 60_000 },
  );
  await page.screenshot({ path: join(directory, "welcome.png") });
  if (process.platform === "darwin") {
    await application.evaluate(async ({ app, BrowserWindow, screen }, modulePath) => {
      const require = process.getBuiltinModule("module").createRequire(modulePath);
      const { ComputerOverlay } = require(modulePath);
      const overlay = new ComputerOverlay();
      const originalWindows = BrowserWindow.getAllWindows();
      const checkDock = (phase) => {
        if (!app.dock.isVisible()) throw new Error(`Computer overlay hid the Dock: ${phase}`);
        if (originalWindows.some((window) => window.isDestroyed() || !window.isVisible()))
          throw new Error(`Computer overlay hid an app window: ${phase}`);
      };
      checkDock("before overlay");
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          overlay.show({ provider: "claude", executionGeneration: cycle + 1 });
          checkDock("creating overlay");
          const windows = BrowserWindow.getAllWindows().filter(
            (window) => !originalWindows.includes(window),
          );
          if (windows.length !== screen.getAllDisplays().length)
            throw new Error(
              `Computer overlay window count ${windows.length} did not match display count ${screen.getAllDisplays().length} on cycle ${cycle}`,
            );
          await Promise.all(windows.map((window) => window.webContents.executeJavaScript("true")));
          for (const window of windows) {
            if (!window.isVisibleOnAllWorkspaces() || window.isFocusable())
              throw new Error("Computer overlay lost its workspace or non-interactive behavior");
          }
          checkDock("showing overlay");
          const closed = windows.map(
            (window) => new Promise((resolve) => window.once("closed", resolve)),
          );
          overlay.clear();
          await Promise.all(closed);
          checkDock("clearing overlay");
        }
      } finally {
        overlay.close();
      }
      checkDock("closing overlay");
    }, overlayModule);
  }
  await page.evaluate(async () => {
    const computer = window.desktopBridge.computerAutomation;
    if (
      !computer ||
      typeof computer.status !== "function" ||
      "execute" in computer ||
      "request" in computer
    )
      throw new Error("Computer bridge must expose controls without an execution path");
    const computerStatus = await computer.status();
    if (
      !computerStatus.available &&
      ![
        "not-certified",
        "helper-missing",
        "missing-permissions",
        "monitor-unhealthy",
        "unsupported-platform",
        "other-instance",
      ].includes(computerStatus.reason)
    )
      throw new Error(`Unexpected computer backend status: ${computerStatus.reason}`);
    const bridge = window.desktopBridge.preview;
    const original = await bridge.getPreviewConfig();
    const persistent = await bridge.profiles.create("Smoke work", true);
    const privateProfile = await bridge.profiles.create("Smoke incognito", false);
    await bridge.profiles.select(privateProfile.id);
    const config = await bridge.createTab("smoke-private-tab", { zoomFactor: 1.25, muted: true });
    if (config.partition.startsWith("persist:") || config.partition === original.partition)
      throw new Error("Incognito isolation failed");
    if (!config.preload.startsWith("file:")) throw new Error("Guest preload is missing");
    let blocked = false;
    try {
      await bridge.profiles.delete(privateProfile.id);
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error("Active profile deletion was allowed");
    await bridge.closeTab("smoke-private-tab");
    await bridge.profiles.delete(privateProfile.id);
    const fallback = await bridge.createTab("smoke-default-after-delete", {
      zoomFactor: 1,
      muted: false,
    });
    if (fallback.partition !== original.partition)
      throw new Error("Deleting the selected profile did not restore the default");
    await bridge.closeTab("smoke-default-after-delete");
    await bridge.profiles.delete(persistent.id);
    await bridge.profiles.select("default");
  });
  const backendOrigin = await page.evaluate(() => {
    const url = new URL(window.desktopBridge.getWsUrl());
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  });
  const authorizedStatus = await page.evaluate(
    async (origin) => (await fetch(`${origin}/api/bootstrap`)).status,
    backendOrigin,
  );
  if (authorizedStatus !== 200) throw new Error("Main renderer backend authentication failed");
  const iframeStatus = await page.evaluate(async (origin) => {
    const frame = document.createElement("iframe");
    frame.srcdoc = "<!doctype html><title>untrusted subframe</title>";
    const loaded = new Promise((resolve) => {
      frame.onload = resolve;
    });
    document.body.append(frame);
    await loaded;
    try {
      return (await frame.contentWindow.fetch(`${origin}/api/bootstrap?smoke=iframe`)).status;
    } finally {
      frame.remove();
    }
  }, backendOrigin);
  if (iframeStatus !== 401)
    throw new Error(`Subframe received backend authorization (${iframeStatus})`);
  await application.evaluate(({ BrowserWindow }, origin) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session;
    globalThis.__smokeImageResponse = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(-1), 10000);
      session.webRequest.onSendHeaders({ urls: [`${origin}/*`] }, (details) => {
        if (details.url === `${origin}/attachments/smoke-missing.png?smoke=iframe-image`) {
          clearTimeout(timer);
          resolve(
            Object.keys(details.requestHeaders).some((key) => key.toLowerCase() === "authorization")
              ? 200
              : 401,
          );
        }
      });
    });
  }, backendOrigin);
  await page.evaluate((origin) => {
    const frame = document.createElement("iframe");
    frame.srcdoc = `<img src="${origin}/attachments/smoke-missing.png?smoke=iframe-image">`;
    frame.id = "smoke-image-frame";
    document.body.append(frame);
  }, backendOrigin);
  const imageStatus = await application.evaluate(async ({ BrowserWindow }) => {
    const status = await globalThis.__smokeImageResponse;
    BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onSendHeaders(null);
    return status;
  });
  if (imageStatus !== 401)
    throw new Error(`Subframe image authorization check returned ${imageStatus}`);
  await page.evaluate(() => document.getElementById("smoke-image-frame")?.remove());
  const popupStatus = await application.evaluate(async ({ BrowserWindow }, origin) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const session = owner.webContents.session;
    const popup = new BrowserWindow({
      show: false,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const target = `${origin}/api/bootstrap?smoke=popup`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Popup request timed out")), 10000);
      session.webRequest.onCompleted({ urls: [`${origin}/*`] }, (details) => {
        if (details.url === target) {
          clearTimeout(timer);
          resolve(details.statusCode);
        }
      });
    });
    try {
      await popup.loadURL(target);
      return await response;
    } finally {
      session.webRequest.onCompleted(null);
      popup.destroy();
    }
  }, backendOrigin);
  if (popupStatus !== 401) throw new Error("Popup received backend authorization");
  const previewConfig = await page.evaluate(() => window.desktopBridge.preview.getPreviewConfig());
  if (!previewConfig.preload || !existsSync(new URL(previewConfig.preload)))
    throw new Error("Built guest preload is missing on disk");
  await application.evaluate(
    ({ session }, { origin, partition }) => {
      const guestSession = session.fromPartition(partition);
      globalThis.__smokeGuestResponse = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Guest request timed out")), 10000);
        guestSession.webRequest.onCompleted({ urls: [`${origin}/*`] }, (details) => {
          if (details.url === `${origin}/api/bootstrap?smoke=guest`) {
            clearTimeout(timer);
            resolve(details.statusCode);
          }
        });
      });
    },
    { origin: backendOrigin, partition: previewConfig.partition },
  );
  const attachedUrl = await page.evaluate(
    ({ origin, partition }) =>
      new Promise((resolve, reject) => {
        const target = `${origin}/api/bootstrap?smoke=guest`;
        const guest = document.createElement("webview");
        guest.id = "smoke-untrusted-guest";
        guest.setAttribute("partition", partition);
        guest.setAttribute("src", target);
        guest.style.height = "100px";
        const timer = setTimeout(() => reject(new Error("Guest did not attach")), 10000);
        guest.addEventListener(
          "dom-ready",
          () => {
            clearTimeout(timer);
            // Guests attach blank. A backend navigation can be vetoed before
            // networking, so test request authentication with a fetch instead.
            // The session's onCompleted receipt must still report exactly 401;
            // a cancellation, timeout or authenticated response never passes.
            const url = guest.getURL();
            void guest
              .executeJavaScript(
                `fetch(${JSON.stringify(target)}, { mode: "no-cors" }).catch(() => undefined)`,
              )
              .catch(() => undefined);
            resolve(url);
          },
          { once: true },
        );
        document.body.append(guest);
      }),
    { origin: backendOrigin, partition: previewConfig.partition },
  );
  if (attachedUrl !== "about:blank")
    throw new Error(`Guest loaded ${attachedUrl} before its tab policy was installed`);
  const guestStatus = await application.evaluate(async ({ session }, partition) => {
    try {
      return await globalThis.__smokeGuestResponse;
    } finally {
      session.fromPartition(partition).webRequest.onCompleted(null);
    }
  }, previewConfig.partition);
  await page.evaluate(() => document.getElementById("smoke-untrusted-guest")?.remove());
  if (guestStatus !== 401) throw new Error(`Guest received backend authorization (${guestStatus})`);

  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "Desktop smoke fixture\n");
  await page.getByRole("button", { name: "Add your first project", exact: true }).click();
  await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").fill(workspace);
  await page.getByRole("button", { name: "Add (Enter)", exact: true }).click();
  // The chat header breadcrumb reuses this label; wait for the sidebar entry.
  await page
    .locator('[data-sidebar="menu-action"]')
    .and(page.getByRole("button", { name: "Project actions for workspace", exact: true }))
    .waitFor({ timeout: 60_000 });
  await page.locator('[contenteditable="true"]').fill("**a****b**\n# Title **bold**");
  await page.reload();
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });
  if (
    (await page.locator('[contenteditable="true"]').innerText()) !== "**a****b**\n# Title **bold**"
  ) {
    throw new Error("Composer draft was not restored after reload");
  }
  // Stop keeps the window and its immutable preload URL, just like an exited backend.
  const stopDefaultBackend = () =>
    application.evaluate(({ Menu }) => {
      const profile = Menu.getApplicationMenu()
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === "Default");
      const stop = profile?.submenu?.items.find((item) => item.label === "Stop");
      if (!stop) throw new Error("Missing default profile Stop action");
      stop.click();
    });
  const waitForBackend = (expected) =>
    page.waitForFunction(
      async ({ origin, expected }) => {
        try {
          return (await fetch(`${origin}/api/bootstrap`)).ok === expected;
        } catch {
          return !expected;
        }
      },
      { origin: backendOrigin, expected },
      { timeout: 60_000 },
    );
  const retainedWsUrl = await page.evaluate(() => window.desktopBridge.getWsUrl());
  const retainedRendererUrl = page.url();
  const recoveryCount = () =>
    readFileSync(join(state, "logs", "desktop-main.log"), "utf8").split(
      "profile open ready profile=",
    ).length - 1;
  const waitForRecovery = async (previousCount) => {
    const deadline = Date.now() + 60_000;
    while (recoveryCount() <= previousCount) {
      if (Date.now() > deadline) throw new Error("Profile recovery did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await waitForBackend(true);
  };
  await stopDefaultBackend();
  await waitForBackend(false);
  const beforeSecondInstance = recoveryCount();
  await application.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
  await waitForRecovery(beforeSecondInstance);
  if ((await page.evaluate(() => window.desktopBridge.getWsUrl())) !== retainedWsUrl)
    throw new Error("Reopening changed the retained window's connection");
  if (
    (await page.locator('[contenteditable="true"]').innerText()) !== "**a****b**\n# Title **bold**"
  )
    throw new Error("Backend recovery changed the retained composer draft");
  if (process.platform === "darwin") {
    await stopDefaultBackend();
    await waitForBackend(false);
    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    const beforeActivate = recoveryCount();
    const reopened = application.waitForEvent("window");
    await application.evaluate(({ app }) => app.emit("activate"));
    page = await reopened;
    page.on("pageerror", (error) => errors.push(error.message));
    await waitForRecovery(beforeActivate);
    await page.goto(retainedRendererUrl);
    await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });
    await waitForBackend(true);
    if (
      (await page.locator('[contenteditable="true"]').innerText()) !==
      "**a****b**\n# Title **bold**"
    )
      throw new Error("Dock recovery did not restore the saved composer draft");
  }
  await page.screenshot({ path: join(directory, "workspace.png") });
  if (errors.length) throw new Error(errors.join("\n"));
  await page.evaluate(() => window.desktopBridge.setAttentionBadge(3));
  if (
    process.platform === "darwin" &&
    (await application.evaluate(({ app }) => app.getBadgeCount())) !== 3
  )
    throw new Error("Desktop attention badge was not updated");
  await page.evaluate(() => window.desktopBridge.setAttentionBadge(0));
  const observeUnloadDialog = () => {};
  page.on("dialog", observeUnloadDialog);
  await page.evaluate(() => {
    window.__smokeQuitVeto = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", window.__smokeQuitVeto);
  });
  await application.evaluate(({ app }) => app.quit());
  await page.waitForTimeout(300);
  if (electronProcess.exitCode !== null) throw new Error("Draft veto did not cancel quit");
  await application.evaluate(({ app }) => app.emit("activate"));
  await waitForBackend(true);
  if (
    !(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ))
  )
    throw new Error("Cancelled quit left the app hidden");
  await page.evaluate(() => window.removeEventListener("beforeunload", window.__smokeQuitVeto));
  page.off("dialog", observeUnloadDialog);
  await page.reload();
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60000 });
  const popupEvent = application.waitForEvent("window");
  await application.evaluate(({ BrowserWindow }) => {
    const popup = new BrowserWindow({ width: 320, height: 240, webPreferences: { sandbox: true } });
    void popup.loadURL("data:text/html,<title>Quit smoke popup</title><p>Quit shortcut smoke</p>");
  });
  const popup = await popupEvent;
  await popup.waitForLoadState();
  // Inject through Electron so this exercises before-input-event on a non-app renderer.
  // CDP keyboard events do not consistently reach that native hook on macOS.
  const pressQuit = () =>
    application.evaluate(async ({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Quit smoke popup",
      );
      if (!popup) throw new Error("Missing quit smoke popup");
      popup.focus();
      popup.webContents.focus();
      const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
      popup.webContents.sendInputEvent({ type: "keyDown", keyCode: "Q", modifiers });
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!popup.isDestroyed())
        popup.webContents.sendInputEvent({ type: "keyUp", keyCode: "Q", modifiers });
    });
  await pressQuit();
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (electronProcess.exitCode !== null) throw new Error("A single quit tap closed the app");
  const closed = application.waitForEvent("close", { timeout: 10000 });
  await pressQuit();
  await pressQuit();
  await closed;
  console.log(`Desktop smoke test passed. Isolated artifacts: ${directory}`);
} catch (error) {
  console.error("Desktop smoke test failed:", error, output);
  process.exitCode = 1;
} finally {
  writeFileSync(join(directory, "desktop.log"), output);
  if (electronProcess?.exitCode === null) await application.close();
}
