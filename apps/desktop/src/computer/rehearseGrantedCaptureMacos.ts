import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Schema } from "effect";
import { ComputerScreenshot, type ComputerAutomationRequest } from "@t3tools/contracts";
import { createRehearsalFixture } from "./rehearsalFixture";
import { protectionFailureSummary } from "./rehearsalProtection";
import { ComputerHelperClient } from "./ComputerHelperClient";

// Background synthetic app only: no existing app is granted, activated or inspected.
// No permit, resume, lease, keyboard or pointer input; images stay in memory.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const executable = argument("--helper");
const output = argument("--output");
if (process.platform !== "darwin" || !executable || !output) {
  process.stderr.write(
    "Usage: bun apps/desktop/src/computer/rehearseGrantedCaptureMacos.ts --helper <dev helper> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "f5-granted-capture-rehearsal-"));
const exec = promisify(execFile);
const helper = new ComputerHelperClient(dirname(resolve(executable)), resolve(executable));
const verifier = join(root, "verifier");
let suspended = true;
let heartbeats = 0;
helper.onEvent((event) => {
  if (event.type === "heartbeat") {
    heartbeats++;
    suspended &&= event.suspended === true;
  }
});
const checks: Array<
  { displayId: string; passed: boolean; markerVisible?: boolean; neutralFrame?: boolean } & Partial<
    ReturnType<typeof protectionFailureSummary>
  >
> = [];
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let metadata: Record<string, unknown> = {};
let expectedChecks = 0;
let failed = false;
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  const verifierSource = resolve(
    import.meta.dirname,
    "../../native/macos/Fixtures/CaptureVerifier.swift",
  );
  const hashes = Object.fromEntries(
    await Promise.all(
      [
        ["helper", resolve(executable)],
        ["rehearsal", import.meta.filename],
        ["verifier", verifierSource],
        ["fixtureLauncher", join(import.meta.dirname, "rehearsalFixture.ts")],
        ["failureSummary", join(import.meta.dirname, "rehearsalProtection.ts")],
        [
          "fixture",
          resolve(import.meta.dirname, "../../native/macos/Fixtures/ComputerControlFixture.swift"),
        ],
      ].map(async ([name, path]) => [
        name!,
        createHash("sha256")
          .update(await readFile(path!))
          .digest("hex"),
      ]),
    ),
  );
  metadata = {
    repositoryCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
    workingTreeDirty: Boolean(
      (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
    ),
    sourceHashes: hashes,
  };
  await exec("swiftc", ["-framework", "AppKit", verifierSource, "-o", verifier], {
    timeout: 30000,
  });
  const appId = `org.example.background-capture.${randomUUID()}`;
  fixture = await createRehearsalFixture({ root, appId, background: true });
  helper.start();
  const deadline = performance.now() + 5000;
  while (!helper.status().available && performance.now() < deadline)
    await new Promise((done) => setTimeout(done, 25));
  const status = helper.status();
  if (!status.available || !status.displays?.length) throw new Error("Helper/display unavailable.");
  metadata.displayGeometry = status.displays;
  expectedChecks = status.displays.length;
  const authorization = {
    profileId: "granted-capture-rehearsal",
    threadId: randomUUID(),
    sessionGeneration: randomUUID(),
    turnId: "observe",
    executionGeneration: 0,
    grantVersion: 1,
    grants: [{ appId, tier: "view" as const, allowTyping: false }],
  };
  helper.control({ type: "grantsChanged", authorization });
  for (const display of status.displays) {
    try {
      const request = {
        op: "screenshot",
        displayId: display.displayId,
        requestId: randomUUID(),
        payloadHash: "granted-capture-observation",
        authorization,
        deadlineAtMs: Date.now() + 10000,
        agent: { provider: "codex", threadTitle: "Background capture diagnostic" },
      } as ComputerAutomationRequest;
      const image = Schema.decodeUnknownSync(ComputerScreenshot)(
        await helper.request(request, {
          f5Pids: [process.pid],
          f5BundlePath: join(root, "protected-host"),
          overlayWindowIds: [],
        }),
      );
      const pixels = await new Promise<{ markerVisible: boolean; neutralFrame: boolean }>(
        (done, reject) => {
          const child = execFile(
            verifier,
            [],
            { timeout: 10000, maxBuffer: 2048 },
            (error, stdout) => {
              if (error) return reject(new Error("Pixel verifier failed."));
              try {
                const result = JSON.parse(stdout);
                done({
                  markerVisible: result.blueMarkerVisible === true,
                  neutralFrame: result.allNeutral === true,
                });
              } catch {
                reject(new Error("Invalid verifier result."));
              }
            },
          );
          child.stdin!.end(
            JSON.stringify({
              data: image.data,
              mimeType: image.mimeType,
              requireBlue: false,
              neutralFrame: true,
            }),
          );
        },
      );
      const passed =
        image.displayId === display.displayId &&
        image.geometryGeneration === display.geometryGeneration &&
        image.mimeType === "image/jpeg" &&
        (pixels.markerVisible || pixels.neutralFrame);
      checks.push({ displayId: display.displayId, passed, ...pixels });
      if (!passed) throw new Error("Capture geometry or encoding changed.");
    } catch (error) {
      if (checks.at(-1)?.displayId !== display.displayId)
        checks.push({
          displayId: display.displayId,
          passed: false,
          ...protectionFailureSummary(error, helper.status()),
        });
      throw error;
    }
  }
} catch {
  failed = true;
} finally {
  helper.close();
  fixture?.child.kill();
  await rm(root, { recursive: true, force: true });
  const passed =
    !failed &&
    expectedChecks > 0 &&
    checks.length === expectedChecks &&
    checks.every((check) => check.passed) &&
    checks.some((check) => check.markerVisible) &&
    suspended &&
    heartbeats > 0;
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
        scope: "unsigned-suspended-helper-background-synthetic-granted-capture",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        helperStayedSuspended: suspended,
        heartbeats,
        checks,
        limitations: [
          "One background synthetic view-tier app only; no existing app, provider, consent, overlay, OS input or active lease tested",
          "Each connected display capture checked with at least one synthetic positive marker; not Chrome, password masking or complete multi-display privacy proof",
          "No signed installed-build attribution, real-keychain/autofill, Windows or complete release certification",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Background granted capture: ${passed ? "passed" : "failed"}; report ${resolve(output)}\n`,
  );
  if (!passed) process.exitCode = 1;
}
