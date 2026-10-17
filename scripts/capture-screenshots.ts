#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
/**
 * capture-screenshots.ts: regenerates the README screenshots and the marketing
 * hero image from seeded demo data.
 *
 *   1. Creates a fresh sandbox root (`f5-screenshots-*` under the OS temp dir)
 *      with its own state dir, an empty HOME and an allowlisted environment.
 *   2. Builds the server and web app (skip with `--skip-build`).
 *   3. Seeds demo data, starts the built server in web mode on loopback and
 *      drives Playwright through `apps/web/scripts/capture-readme-screenshots.mjs`.
 *   4. Verifies that no provider turn was started or replayed while the
 *      server ran.
 *
 * The sandbox root is kept after exit for inspection.
 *
 * Usage:
 *   bun run screenshots:capture [-- --skip-build]
 */
import { Database } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { type ChildExit, isRunning, stopChild, waitForChild } from "./lib/child-lifecycle.ts";
import {
  createDemoRoot,
  demoStateDir,
  isolatedEnv,
  writeDemoSettings,
} from "./lib/demo-sandbox.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WEB_DIR = path.join(REPO_ROOT, "apps/web");
const skipBuild = process.argv.includes("--skip-build");

const log = (message: string) => console.log(`[screenshots] ${message}`);

// The browser driver only talks to the loopback server, but it still gets a
// minimal environment: enough to find Node and Playwright's browser cache,
// and no provider keys or forge tokens from the parent shell.
const BROWSER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;
const browserEnv: Record<string, string> = {};
for (const key of BROWSER_ENV_KEYS) {
  const value = process.env[key];
  if (value !== undefined) browserEnv[key] = value;
}

// Headless launches use Playwright's headless shell, so launching is the only
// reliable check; the full Chromium executable path may legitimately be absent.
function playwrightChromiumAvailable(): boolean {
  const result = spawnSync(
    "node",
    ["-e", "require('playwright').chromium.launch().then((browser) => browser.close())"],
    { cwd: WEB_DIR, encoding: "utf8", timeout: 60_000, env: browserEnv },
  );
  if (result.status === 0) return true;
  const detail = result.error?.message ?? result.stderr?.trim().split("\n")[0];
  if (detail) console.error(detail);
  return false;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No free loopback port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

class Interrupted extends Error {}

interface DeliverySnapshot {
  readonly deliveries: number;
  readonly maxSequence: number;
}

function snapshot(dbPath: string): DeliverySnapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    const deliveries = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM provider_turn_deliveries")
      .get()!.count;
    const maxSequence = db
      .query<{ max: number | null }, []>("SELECT MAX(sequence) AS max FROM orchestration_events")
      .get()!.max;
    return { deliveries, maxSequence: maxSequence ?? 0 };
  } finally {
    db.close();
  }
}

function noTurnViolations(dbPath: string, before: DeliverySnapshot, serverLog: string): string[] {
  const violations: string[] = [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const after = snapshot(dbPath);
    if (after.deliveries !== before.deliveries) {
      violations.push(`delivery rows changed from ${before.deliveries} to ${after.deliveries}`);
    }
    const replayable = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM provider_turn_deliveries WHERE state <> 'accepted' OR outcome_projected_at IS NULL",
      )
      .get()!.count;
    if (replayable > 0) violations.push(`${replayable} delivery rows are replayable`);
    const turnEvents = db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM orchestration_events WHERE sequence > ? AND event_type IN ('thread.turn-start-requested', 'thread.turn-steer-requested')",
      )
      .get(before.maxSequence)!.count;
    if (turnEvents > 0) violations.push(`${turnEvents} turn start/steer events were appended`);
    const markers = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM restart_turn_markers")
      .get()!.count;
    if (markers > 0) violations.push(`${markers} restart turn markers exist`);
    // Startup may also prune old events, so count by sequence, not row totals.
    const appended = db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM orchestration_events WHERE sequence > ?",
      )
      .get(before.maxSequence)!.count;
    log(`server startup appended ${appended} orchestration events`);
  } finally {
    db.close();
  }
  if (serverLog.split("\n").some((line) => line.includes("provider delivery"))) {
    violations.push('server.log mentions "provider delivery"');
  }
  return violations;
}

const root = createDemoRoot("f5-screenshots-");
const stateDir = demoStateDir(root);
const dbPath = path.join(stateDir, "state.sqlite");
const serverLogPath = path.join(root, "server.log");
const env = isolatedEnv(root);
let server: ChildProcess | undefined;
let serverStopping = false;
let serverError: Error | null = null;
let serverUnexpectedExit: ChildExit | null = null;
let capture: ChildProcess | undefined;
let failed = false;

// A signal only records the interrupt and stops the browser so the main flow
// unblocks; the `finally` below owns all other cleanup, so the server is
// stopped once and no checks run after an interrupt.
let interrupted: { readonly signal: NodeJS.Signals; readonly code: number } | null = null;
const onSignal = (signal: NodeJS.Signals, code: number) => {
  if (interrupted) return;
  interrupted = { signal, code };
  log(`received ${signal}; stopping`);
  if (isRunning(capture)) capture.kill("SIGTERM");
};
process.once("SIGINT", () => onSignal("SIGINT", 130));
process.once("SIGTERM", () => onSignal("SIGTERM", 143));
const checkInterrupted = () => {
  if (interrupted) throw new Interrupted();
};

const serverLogText = () => fs.readFileSync(serverLogPath, "utf8");
const checkServerAlive = () => {
  if (serverError) throw new Error(`server failed to start: ${serverError.message}`);
  if (serverUnexpectedExit) {
    throw new Error(
      `server exited unexpectedly (code=${serverUnexpectedExit.code}, signal=${serverUnexpectedExit.signal}):\n${serverLogText()}`,
    );
  }
};

try {
  if (!playwrightChromiumAvailable()) {
    console.error(
      "Chromium for Playwright is missing. Run: bun run --cwd apps/web test:browser:install",
    );
    process.exit(1);
  }

  log(`sandbox root: ${root}`);
  writeDemoSettings(root);

  if (!skipBuild) {
    log("building server and web app...");
    const built = spawnSync(
      "node",
      ["node_modules/turbo/bin/turbo", "run", "build", "--filter=t3"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );
    if (built.status !== 0) {
      console.error(`[screenshots] build failed with exit code ${built.status}`);
      process.exit(built.status ?? 1);
    }
  }
  checkInterrupted();

  log("seeding demo data...");
  const seeded = spawnSync("bun", ["run", "apps/server/scripts/seed-demo.ts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
  });
  checkInterrupted();
  if (seeded.status !== 0) throw new Error(`seed-demo failed with exit code ${seeded.status}`);
  const before = snapshot(dbPath);
  log(`seeded ${before.deliveries} delivery rows, max event sequence ${before.maxSequence}`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = fs.openSync(serverLogPath, "w");
  // Run from the sandbox root with cwd bootstrapping off: web mode otherwise
  // adds the working directory as a project and opens a new thread in it.
  server = spawn(
    "node",
    [
      path.join(REPO_ROOT, "apps/server/dist/index.mjs"),
      "--mode",
      "web",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--state-dir",
      stateDir,
      "--no-browser",
    ],
    {
      cwd: root,
      env: { ...env, T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false" },
      stdio: ["ignore", serverLog, serverLog],
    },
  );
  fs.closeSync(serverLog);
  server.once("error", (error) => {
    serverError = error;
  });
  server.once("exit", (code, signal) => {
    if (!serverStopping) serverUnexpectedExit = { code, signal };
  });

  let ready = false;
  for (let attempt = 0; attempt < 240 && !ready; attempt++) {
    checkInterrupted();
    checkServerAlive();
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        ready = Boolean(body && typeof body === "object" && "protocolVersion" in body);
      }
    } catch {
      /* Wait for migrations and startup. */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    throw new Error(`server did not become ready:\n${serverLogText()}`);
  }
  if (serverLogText().includes("failed to parse settings.json")) {
    throw new Error("server could not parse the demo settings.json");
  }
  log(`server ready at ${baseUrl}`);

  capture = spawn("node", ["scripts/capture-readme-screenshots.mjs", baseUrl, REPO_ROOT], {
    cwd: WEB_DIR,
    stdio: "inherit",
    env: browserEnv,
  });
  // Rejects on a spawn error, so a browser that never starts cannot hang the run.
  const captureExit = await waitForChild(capture);
  checkInterrupted();
  if (captureExit.code !== 0) {
    failed = true;
    console.error(
      `[screenshots] capture failed (code=${captureExit.code}, signal=${captureExit.signal})`,
    );
  }
  // A server that died during capture invalidates the screenshots even if the
  // browser happened to finish.
  checkServerAlive();

  const violations = noTurnViolations(dbPath, before, serverLogText());
  for (const violation of violations)
    console.error(`[screenshots] no-turn check failed: ${violation}`);
  if (violations.length > 0) failed = true;
  else log("no-turn checks passed");
} catch (error) {
  if (!(error instanceof Interrupted)) {
    failed = true;
    console.error(`[screenshots] ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await stopChild(capture);
  serverStopping = true;
  await stopChild(server);
  // SIGTERM is our own stop; anything else (SIGKILL after the grace period,
  // a crash) means the server did not shut down cleanly.
  if (server?.signalCode && server.signalCode !== "SIGTERM") failed = true;
  if (capture?.signalCode && !interrupted) failed = true;
  log(`sandbox kept at ${root}`);
}

const interruptedBy = interrupted as { readonly code: number } | null;
process.exit(interruptedBy ? interruptedBy.code : failed ? 1 : 0);
