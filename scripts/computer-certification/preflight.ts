import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { ComputerAutomationBackendStatus } from "@t3tools/contracts";
import { prepareRehearsalClaude } from "@t3tools/shared/computerRehearsalClaude";
import { cleanEnvironment } from "./process";
import { helperPath, signature, type Target } from "./identity";
import { record } from "./model";
import type { Launches } from "./commands";

/** Never sends grants, permit, resume, capture or input. Starts and exits suspended. */
export async function suspendedProbe(path: string) {
  return new Promise<ComputerAutomationBackendStatus>((done) => {
    const child = spawn(path, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnvironment(),
      windowsHide: true,
    });
    let buffer = "";
    let result: ComputerAutomationBackendStatus = { available: false, reason: "helper-missing" };
    let replied = false;
    const stop = (value: ComputerAutomationBackendStatus) => {
      result = value;
      replied = true;
      child.kill();
    };
    const timeout = setTimeout(() => stop({ available: false, reason: "helper-crashed" }), 5000);
    const force = setTimeout(() => child.kill("SIGKILL"), 6000);
    child.stderr.resume();
    child.stdin.on("error", () => stop({ available: false, reason: "helper-crashed" }));
    child.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (replied) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        stop({ available: false, reason: "helper-crashed" });
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (!record(message)) throw new Error("Invalid helper packet");
          if (message.type === "hello") {
            if (message.protocolVersion !== 1) throw new Error("Protocol mismatch");
            child.stdin.write(
              JSON.stringify({
                type: "request",
                request: { op: "status", requestId: "suite-preflight" },
              }) + "\n",
            );
          } else if (message.type === "response" && message.requestId === "suite-preflight") {
            stop(Schema.decodeUnknownSync(ComputerAutomationBackendStatus)(message.result));
          } else if (message.type === "status") {
            const status = Schema.decodeUnknownSync(ComputerAutomationBackendStatus)(
              message.status,
            );
            if (!status.available) stop(status);
          }
        } catch {
          stop({ available: false, reason: "helper-crashed" });
        }
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      done(
        replied && (code === 0 || code === null)
          ? result
          : { available: false, reason: "helper-crashed" },
      );
    });
  });
}

export async function preflight(target: Target, launches: Launches) {
  const hostMatches = process.platform === target.platform;
  const status = hostMatches
    ? await suspendedProbe(helperPath(target))
    : { available: false as const, reason: "unsupported-platform" as const };
  const checks: Record<string, boolean> = {
    platform: hostMatches,
    "helper-permissions": status.available,
    "app-signature": target.app ? await signature(target.app, target.platform) : false,
    "helper-signature": target.app ? await signature(helperPath(target), target.platform) : false,
  };
  const versions: Record<string, string> = {};
  const exec = promisify(execFile);
  for (const provider of ["codex", "claude"] as const) {
    const launch = launches[provider];
    checks[provider + "-ready"] = false;
    if (!launch || !hostMatches) continue;
    try {
      const version = await exec(launch.binary, ["--version"], {
        env: cleanEnvironment(),
        timeout: 10000,
        maxBuffer: 8192,
      });
      const found = (version.stdout + version.stderr).match(/\b\d+\.\d+\.\d+\b/);
      if (!found) continue;
      versions[provider] = found[0];
      if (provider === "codex") {
        await access(join(launch.home, "auth.json"));
        const auth = await exec(launch.binary, ["auth", "status"], {
          env: cleanEnvironment({ CODEX_HOME: launch.home }),
          timeout: 15000,
          maxBuffer: 8192,
        });
        checks["codex-ready"] = /logged in/i.test(auth.stdout + auth.stderr);
      } else {
        const root = await mkdtemp(join(tmpdir(), "f5-suite-claude-preflight-"));
        try {
          const prepared = await prepareRehearsalClaude({
            binary: launch.binary,
            sourceHome: launch.home,
            isolatedHome: join(root, "home"),
            root,
          });
          checks["claude-ready"] = prepared.authentication.status === "authenticated";
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    } catch {
      /* Safe readiness false; account output is never persisted. */
    }
  }
  return {
    checks,
    providerVersions: versions,
    displays: status.available ? (status.displays ?? []) : [],
  };
}
