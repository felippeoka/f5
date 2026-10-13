import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import {
  ComputerApp,
  ComputerInspectResult,
  ComputerScreenshot,
  type ComputerAutomationRequest,
  type ComputerAuthorization,
  type ComputerGrant,
} from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture } from "./rehearsalFixture";
import {
  BROWSER_PROTECTION_IDS,
  BROWSER_SECURE_LABEL,
  BROWSER_MARKER_LABEL,
  browserProtectionHtml,
  browserSecureInspection,
  expectedProtectionRefusal,
  protectionFixtureState,
  type ProtectionFixtureState,
} from "./rehearsalProtection";

// Opt-in native-helper boundary checks, not provider consent or release certification.
// Terminal receives a click-only grant, never command/key input. Chrome receives
// a new private profile and a local synthetic password page, never a user profile.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
const chromeBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_PROTECTION_REHEARSAL !== "1" ||
  !helperPath ||
  !output
) {
  process.stderr.write(
    "Human idle coordination required: F5_COMPUTER_PROTECTION_REHEARSAL=1 bun apps/desktop/src/computer/rehearseProtectedAppsMacos.ts --helper <dev helper> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-protected-apps-rehearsal-"));
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
const nativeSource = resolve(import.meta.dirname, "../../native/macos/Fixtures");
const appVerifier = join(root, "app-verifier");
const captureVerifier = join(root, "capture-verifier");
const nonce = randomBytes(16).toString("hex");
const pagePath = `/${nonce}/fixture`;
const statePath = `/${nonce}/state`;
let pageState: ProtectionFixtureState | undefined;
let lastPageObservation = 0;
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === pagePath) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    });
    response.end(browserProtectionHtml(statePath));
  } else if (request.method === "POST" && request.url === statePath) {
    let body = "";
    request.setEncoding("utf8");
    request.on("error", () => {});
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 2048) request.destroy();
    });
    request.on("end", () => {
      try {
        const state = protectionFixtureState(JSON.parse(body));
        if (!state) throw new Error("Invalid fixture observation.");
        pageState = state;
        lastPageObservation = performance.now();
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  } else {
    response.writeHead(404).end();
  }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
const checks: Array<{
  name: string;
  state: "passed" | "failed";
  outcome?: string;
  elapsedMs: number;
}> = [];
let stage = "prerequisites";
let failureStage: string | undefined;
let physicalInterruption = false;
let chrome: ChildProcess | undefined;
let excluded: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let renewal: ReturnType<typeof setInterval> | undefined;
let startedTerminalPid: number | undefined;
let terminalLaunchAttempted = false;
let startedChromePid: number | undefined;
let retainedTerminal = false;
let retainedChrome = false;
let metadata: Record<string, unknown> = {};
let authorization: ComputerAuthorization = {
  profileId: "native-protection-rehearsal",
  threadId: randomUUID(),
  sessionGeneration: randomUUID(),
  turnId: "protection-check",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
helper.onEvent((event) => {
  if (event.type === "physicalInput" || event.type === "killSwitch") physicalInterruption = true;
});
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function waitFor(condition: () => boolean | Promise<boolean>, ms = 10000) {
  const deadline = performance.now() + ms;
  while (!(await condition())) {
    if (physicalInterruption || performance.now() >= deadline)
      throw new Error("Rehearsal interrupted or timed out.");
    await delay(25);
  }
}
function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Protection assertion failed.");
}
async function check(name: string, run: () => Promise<void>) {
  stage = name;
  process.stdout.write(`Checking: ${name}\n`);
  const start = performance.now();
  try {
    if (physicalInterruption) throw new Error("Physical interruption.");
    await run();
    checks.push({ name, state: "passed", elapsedMs: Math.round(performance.now() - start) });
  } catch (error) {
    checks.push({
      name,
      state: "failed",
      elapsedMs: Math.round(performance.now() - start),
      outcome: error instanceof ComputerControlError ? error.error._tag : "ProtectionCheckFailed",
    });
    throw error;
  }
}
type Operation = ComputerAutomationRequest extends infer R
  ? R extends ComputerAutomationRequest
    ? Omit<R, "requestId" | "payloadHash" | "authorization" | "deadlineAtMs" | "agent">
    : never
  : never;
async function request<T>(operation: Operation): Promise<T> {
  if (physicalInterruption) throw new Error("Physical interruption; no automatic resume.");
  return (await helper.request(
    {
      ...operation,
      requestId: randomUUID(),
      payloadHash: createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
      authorization,
      deadlineAtMs: Date.now() + 10000,
      agent: { provider: "codex", threadTitle: "Native protection rehearsal" },
    } as ComputerAutomationRequest,
    { f5Pids: [process.pid], f5BundlePath: join(root, "protected-host"), overlayWindowIds: [] },
  )) as T;
}
async function requireRefusal(
  operation: Operation,
  kind: Parameters<typeof expectedProtectionRefusal>[1],
) {
  try {
    await request(operation);
  } catch (error) {
    if (expectedProtectionRefusal(error, kind)) return;
    throw error;
  }
  // Stop immediately: an unexpectedly successful action is never retried.
  throw new Error("Protected request unexpectedly succeeded.");
}
function setGrants(grants: ReadonlyArray<ComputerGrant>) {
  authorization = { ...authorization, grantVersion: authorization.grantVersion + 1, grants };
  helper.control({ type: "grantsChanged", authorization });
}
async function appPids(): Promise<Record<string, number[]>> {
  const status = await exec(appVerifier, ["--status"], { timeout: 5000, maxBuffer: 2048 });
  return JSON.parse(status.stdout) as Record<string, number[]>;
}
async function inspect(appId: string) {
  return Schema.decodeUnknownSync(ComputerInspectResult)(
    await request({ op: "inspect", appId, maxNodes: 400 }),
  );
}
async function requireFrontmost(appId: string) {
  const apps = Schema.decodeUnknownSync(Schema.Array(ComputerApp))(
    await request({ op: "listApps" }),
  );
  assert(
    apps.filter((app) => app.frontmost).length === 1 &&
      apps.some((app) => app.frontmost && app.appId === appId),
  );
}
async function verifyPixels(
  image: ComputerScreenshot,
  rectangles: {
    secureRect?: { x: number; y: number; width: number; height: number };
    blueRect?: { x: number; y: number; width: number; height: number };
    greenRect?: { x: number; y: number; width: number; height: number };
  },
) {
  return new Promise<{
    blueMarkerVisible: boolean;
    greenMarkerVisible: boolean;
    secureMasked: boolean;
  }>((done, reject) => {
    const child = execFile(
      captureVerifier,
      [],
      { timeout: 10000, maxBuffer: 2048 },
      (error, stdout) => {
        if (error) return reject(new Error("Pixel verifier failed."));
        try {
          done(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid pixel verification."));
        }
      },
    );
    child.stdin?.end(
      JSON.stringify({
        data: image.data,
        mimeType: image.mimeType,
        requireBlue: false,
        ...rectangles,
      }),
    );
  });
}
async function capture(displayId: string) {
  return Schema.decodeUnknownSync(ComputerScreenshot)(
    await request({ op: "screenshot", displayId }),
  );
}
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        ["rehearsal", import.meta.filename],
        ["protection", join(import.meta.dirname, "rehearsalProtection.ts")],
        ["apps", join(nativeSource, "ProtectionAppVerifier.swift")],
        ["pixels", join(nativeSource, "CaptureVerifier.swift")],
        ["excludedFixture", join(nativeSource, "ComputerControlFixture.swift")],
        ["chromeExecutable", chromeBinary],
        ["helper", resolve(helperPath)],
      ].map(async ([name, file]) => [
        name!,
        createHash("sha256")
          .update(await readFile(file!))
          .digest("hex"),
      ]),
    ),
  );
  metadata = {
    repositoryCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
    workingTreeDirty: Boolean(
      (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
    ),
    sourceHashes,
  };
  const chromeVersion = (
    await exec(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleShortVersionString",
        "/Applications/Google Chrome.app/Contents/Info.plist",
      ],
      { timeout: 5000, maxBuffer: 1024 },
    )
  ).stdout.trim();
  assert(/^\d{1,4}(\.\d{1,8}){1,4}$/.test(chromeVersion));
  metadata.chromeVersion = chromeVersion;
  await exec(
    "swiftc",
    ["-framework", "AppKit", join(nativeSource, "ProtectionAppVerifier.swift"), "-o", appVerifier],
    { timeout: 30000 },
  );
  await exec(
    "swiftc",
    ["-framework", "AppKit", join(nativeSource, "CaptureVerifier.swift"), "-o", captureVerifier],
    { timeout: 30000 },
  );
  await check("Terminal and Chrome initially closed", async () => {
    const pids = await appPids();
    assert(
      pids[BROWSER_PROTECTION_IDS.terminal]?.length === 0 &&
        pids[BROWSER_PROTECTION_IDS.browser]?.length === 0,
    );
  });
  helper.start();
  stage = "helper-startup";
  await waitFor(() => helper.status().available, 5000);
  const status = helper.status();
  if (status.available) metadata.displayGeometry = status.displays;
  setGrants([{ appId: BROWSER_PROTECTION_IDS.terminal, tier: "click", allowTyping: false }]);
  helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 });
  helper.control({ type: "resume", executionGeneration: 1 });
  renewal = setInterval(
    () => helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 }),
    250,
  );
  await check("Granted click-tier Terminal opens and is inspectable", async () => {
    terminalLaunchAttempted = true;
    await request({ op: "openApp", appId: BROWSER_PROTECTION_IDS.terminal });
    await waitFor(async () => (await appPids())[BROWSER_PROTECTION_IDS.terminal]?.length === 1);
    startedTerminalPid = (await appPids())[BROWSER_PROTECTION_IDS.terminal]![0];
    const tree = await inspect(BROWSER_PROTECTION_IDS.terminal);
    assert(tree.accessible && tree.nodes.length > 0);
  });
  await check("Terminal without typing grant rejects keyboard input", async () => {
    await requireFrontmost(BROWSER_PROTECTION_IDS.terminal);
    await requireRefusal({ op: "type", text: "F5_REJECTED_INPUT" }, "typing-grant");
    await requireFrontmost(BROWSER_PROTECTION_IDS.terminal);
  });
  await check("Terminal without typing grant rejects semantic setValue", async () => {
    const tree = await inspect(BROWSER_PROTECTION_IDS.terminal);
    const target = tree.nodes.find((node) => node.role === "AXTextArea");
    assert(target);
    await requireRefusal(
      {
        op: "elementAction",
        appId: tree.appId,
        snapshotId: tree.snapshotId,
        elementRef: target.elementRef,
        action: "setValue",
        value: "F5_REJECTED_INPUT",
      },
      "typing-grant",
    );
  });
  const browserGrant: ComputerGrant = {
    appId: BROWSER_PROTECTION_IDS.browser,
    tier: "full",
    allowTyping: false,
  };
  stage = "isolated-browser-setup";
  const excludedId = `org.example.protection-excluded.${randomUUID()}`;
  excluded = await createRehearsalFixture({ root, appId: excludedId, ungranted: true });
  const excludedGrant: ComputerGrant = { appId: excludedId, tier: "full", allowTyping: false };
  setGrants([browserGrant, excludedGrant]);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  // Fixed isolated profile; no Chrome automation port, extension or default-profile state.
  chrome = spawn(
    chromeBinary,
    [
      `--user-data-dir=${join(root, "chrome-profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-extensions",
      "--new-window",
      "--window-size=800,600",
      "--window-position=650,100",
      `http://127.0.0.1:${address.port}${pagePath}`,
    ],
    { stdio: "ignore" },
  );
  chrome.on("error", () => {
    /* Prerequisite wait fails without leaking raw errors. */
  });
  startedChromePid = chrome.pid;
  await waitFor(async () => {
    const pids = (await appPids())[BROWSER_PROTECTION_IDS.browser];
    return pids?.length === 1 && pids[0] === chrome?.pid && pageState?.ready === true;
  });
  await request({ op: "activateApp", appId: BROWSER_PROTECTION_IDS.browser });
  await waitFor(() => pageState?.secureFocused === true);
  let browserSnapshot: ComputerInspectResult | undefined;
  await check(
    "Chrome inspection identifies the synthetic secure field and omits its value",
    async () => {
      browserSnapshot = await inspect(BROWSER_PROTECTION_IDS.browser);
      assert(browserSecureInspection(browserSnapshot));
    },
  );
  await check("Chrome secure semantic setValue is refused", async () => {
    assert(browserSnapshot);
    const secure = browserSnapshot.nodes.find((node) => node.name === BROWSER_SECURE_LABEL)!;
    await requireRefusal(
      {
        op: "elementAction",
        appId: browserSnapshot.appId,
        snapshotId: browserSnapshot.snapshotId,
        elementRef: secure.elementRef,
        action: "setValue",
        value: "F5_REJECTED_INPUT",
      },
      "secure-field",
    );
  });
  await check(
    "Focused Chrome password refuses keyboard typing with unchanged DOM value",
    async () => {
      await requireFrontmost(BROWSER_PROTECTION_IDS.browser);
      assert(pageState?.secureFocused && pageState.secureUnchanged && pageState.inputEvents === 0);
      await requireRefusal({ op: "type", text: "F5_REJECTED_INPUT" }, "secure-field");
      await delay(350);
      const after = performance.now();
      await waitFor(() => lastPageObservation > after);
      await requireFrontmost(BROWSER_PROTECTION_IDS.browser);
      assert(pageState?.secureFocused && pageState.secureUnchanged && pageState.inputEvents === 0);
    },
  );
  browserSnapshot = await inspect(BROWSER_PROTECTION_IDS.browser);
  const secure = browserSnapshot.nodes.find((node) => node.name === BROWSER_SECURE_LABEL);
  const marker = browserSnapshot.nodes.find((node) => node.name === BROWSER_MARKER_LABEL);
  const excludedSnapshot = await inspect(excludedId);
  const green = excludedSnapshot.nodes.find((node) => node.name === "Rehearsal capture marker");
  assert(
    secure?.bounds &&
      secure.displayId &&
      marker?.bounds &&
      green?.bounds &&
      secure.displayId === marker.displayId &&
      secure.displayId === green.displayId,
  );
  const rects = { secureRect: secure.bounds, blueRect: marker.bounds, greenRect: green.bounds };
  await check(
    "Capture positive control includes both granted markers and masks Chrome password",
    async () => {
      const pixels = await verifyPixels(await capture(secure.displayId!), rects);
      assert(pixels.blueMarkerVisible && pixels.greenMarkerVisible && pixels.secureMasked);
    },
  );
  setGrants([browserGrant]);
  await check("Revoked app inspection is refused", async () => {
    await requireRefusal({ op: "inspect", appId: excludedId, maxNodes: 100 }, "view-grant");
  });
  await check(
    "Capture omits revoked app marker while preserving browser marker and secure mask",
    async () => {
      const image = await capture(secure.displayId!);
      const pixels = await verifyPixels(image, rects);
      assert(
        image.hiddenContent &&
          pixels.blueMarkerVisible &&
          !pixels.greenMarkerVisible &&
          pixels.secureMasked,
      );
    },
  );
  await check("Chrome password zoom is masked", async () => {
    const image = Schema.decodeUnknownSync(ComputerScreenshot)(
      await request({ op: "zoom", displayId: secure.displayId!, rect: secure.bounds! }),
    );
    const pixels = await verifyPixels(image, { secureRect: { x: 0, y: 0, ...image.modelSize } });
    assert(pixels.secureMasked);
  });
  setGrants([]);
  await check("Revoked browser inspection and capture exclude its fixture", async () => {
    await requireRefusal(
      { op: "inspect", appId: BROWSER_PROTECTION_IDS.browser, maxNodes: 100 },
      "view-grant",
    );
    const image = await capture(secure.displayId!);
    const pixels = await verifyPixels(image, {
      blueRect: rects.blueRect,
      greenRect: rects.greenRect,
    });
    assert(image.hiddenContent && !pixels.blueMarkerVisible && !pixels.greenMarkerVisible);
  });
  stage = "finished";
} catch {
  failureStage = stage;
  process.exitCode = 1;
} finally {
  clearInterval(renewal);
  await helper.suspend();
  helper.close();
  excluded?.child.kill();
  if (terminalLaunchAttempted && !startedTerminalPid) retainedTerminal = true;
  // Never force-quit or adopt a pre-existing app. If physical input occurred or
  // a process cannot be identified/closed, retain it and its private state.
  for (const [id, pid] of [
    [BROWSER_PROTECTION_IDS.terminal, startedTerminalPid],
    [BROWSER_PROTECTION_IDS.browser, startedChromePid],
  ] as const) {
    if (!pid) continue;
    if (!physicalInterruption) {
      await exec(appVerifier, ["--terminate-owned", id, String(pid)], {
        timeout: 5000,
        maxBuffer: 2048,
      }).catch(() => undefined);
      const deadline = performance.now() + 5000;
      while (
        performance.now() < deadline &&
        (await appPids().catch(() => ({}) as Record<string, number[]>))[id]?.includes(pid)
      )
        await delay(50);
    }
    const pids = await appPids().catch(() => undefined);
    const retained =
      !pids ||
      pids[id]?.includes(pid) === true ||
      (id === BROWSER_PROTECTION_IDS.browser &&
        chrome?.exitCode === null &&
        chrome.signalCode === null);
    if (id === BROWSER_PROTECTION_IDS.terminal) retainedTerminal = retained;
    else retainedChrome = retained;
  }
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
  if (retainedChrome)
    process.stdout.write(
      `Private Chrome test profile retained at ${join(root, "chrome-profile")}; close the test browser before removing it.\n`,
    );
  else await rm(root, { recursive: true, force: true });
  const passed =
    !failureStage &&
    !physicalInterruption &&
    checks.length === 12 &&
    checks.every((item) => item.state === "passed") &&
    !retainedChrome &&
    !retainedTerminal;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        ...metadata,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        scope: "unsigned-native-helper-terminal-and-isolated-chrome-protection",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        ...(failureStage ? { failureStage } : {}),
        physicalInterruption,
        retainedTerminal,
        retainedChrome,
        browserFixture: pageState
          ? { secureValueUnchanged: pageState.secureUnchanged, inputEvents: pageState.inputEvents }
          : undefined,
        checks,
        limitations: [
          "Scripted native-helper grants and permit; no F5 renderer consent, provider transport, overlay or cross-profile proof",
          "Fresh local Chrome fixture/profile only; no signed-in sites, extensions, popups or arbitrary browser/app trees tested",
          "Single display, fixed app windows; no moving-window, multi-display, system-surface or complete capture privacy matrix",
          "Terminal typing remains disabled; no command, chord or allow-typing workflow tested",
          "Unsigned development helper only; signed installed-build attribution, Windows runtime and all release gates remain pending",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Protection check finished. You can use your computer again. Report: ${resolve(output)} (${passed ? "passed" : "failed"}; release gates unchanged).\n`,
  );
  if (!passed) process.exitCode = 1;
}
