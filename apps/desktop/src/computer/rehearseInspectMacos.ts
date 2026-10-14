import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import { ComputerInspectResult, type ComputerAutomationRequest } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture } from "./rehearsalFixture";
import { rehearsalExecutionCode } from "./rehearsalResponses";

// Observation only: one background synthetic app, a fixture-only grant, no permit,
// resume, capture, activation, input, provider session or existing-user-app grant.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const helperPath = argument("--helper");
const output = argument("--output");
if (process.platform !== "darwin" || !helperPath || !output) {
  process.stderr.write(
    "Usage: bun apps/desktop/src/computer/rehearseInspectMacos.ts --helper <dev helper> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-inspect-diagnostic-"));
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let heartbeats = 0;
let suspended = true;
helper.onEvent((event) => {
  if (event.type === "heartbeat") {
    heartbeats++;
    suspended &&= event.suspended === true;
  }
});
const checks: Array<Record<string, string | number | boolean>> = [];
let failure = false;
const helperSha256 = createHash("sha256")
  .update(await readFile(resolve(helperPath)))
  .digest("hex");
const sourceSha256 = createHash("sha256")
  .update(await readFile(import.meta.filename))
  .digest("hex");
const repositoryCommit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
const workingTreeDirty = Boolean((await exec("git", ["status", "--porcelain"])).stdout.trim());
const fixtureSource = resolve(
  import.meta.dirname,
  "../../native/macos/Fixtures/ComputerControlFixture.swift",
);
const fixtureSourceSha256 = createHash("sha256")
  .update(await readFile(fixtureSource))
  .digest("hex");
try {
  helper.start();
  const startupDeadline = performance.now() + 5000;
  while (!helper.status().available && performance.now() < startupDeadline)
    await new Promise((done) => setTimeout(done, 25));
  if (!helper.status().available) throw new Error("Helper unavailable.");
  const appId = `org.example.inspect-diagnostic.${randomUUID()}`;
  fixture = await createRehearsalFixture({
    root,
    appId,
    background: true,
    sourceFile: fixtureSource,
  });
  const authorization = {
    profileId: "inspection-diagnostic",
    threadId: randomUUID(),
    sessionGeneration: randomUUID(),
    turnId: "observation",
    executionGeneration: 0,
    grantVersion: 1,
    grants: [{ appId, tier: "full" as const, allowTyping: false }],
  };
  helper.control({ type: "grantsChanged", authorization });
  for (const maxNodes of [20, 100, 400]) {
    const start = performance.now();
    try {
      const result = Schema.decodeUnknownSync(ComputerInspectResult)(
        await helper.request(
          {
            op: "inspect",
            appId,
            maxNodes,
            requestId: randomUUID(),
            payloadHash: "diagnostic",
            authorization,
            deadlineAtMs: Date.now() + 30_000,
            agent: { provider: "codex", threadTitle: "Background inspection diagnostic" },
          } satisfies ComputerAutomationRequest,
          {
            f5Pids: [process.pid],
            f5BundlePath: join(root, "protected-host"),
            overlayWindowIds: [],
          },
        ),
      );
      checks.push({
        maxNodes,
        elapsedMs: Math.round(performance.now() - start),
        accessible: result.accessible,
        nodes: result.nodes.length,
        outcome: "ok",
      });
      if (!result.accessible || !result.nodes.length) {
        failure = true;
        break;
      }
    } catch (error) {
      const tag = error instanceof ComputerControlError ? error.error._tag : "diagnostic-failure";
      const code =
        error instanceof ComputerControlError && error.error._tag === "Execution"
          ? rehearsalExecutionCode(error.error.message)
          : undefined;
      checks.push({
        maxNodes,
        elapsedMs: Math.round(performance.now() - start),
        outcome: tag,
        ...(code ? { executionCode: code } : {}),
      });
      failure = true;
      break;
    }
  }
} catch {
  failure = true;
} finally {
  helper.close();
  fixture?.child.kill();
  await rm(root, { recursive: true, force: true });
  const passed = !failure && suspended && heartbeats > 0 && checks.length === 3;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        repositoryCommit,
        workingTreeDirty,
        sourceSha256,
        fixtureSourceSha256,
        helperSha256,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        scope: "unsigned-background-synthetic-app-inspection-only",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        helperStayedSuspended: suspended,
        heartbeats,
        checks,
        limitations: [
          "Scripted grant only for the synthetic fixture, without any execution permit; no F5 consent or provider transport proof",
          "No input, capture, focus/activation, installed-build TCC attribution or release certification",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Background inspection: ${passed ? "passed" : "failed"}; report ${resolve(output)}\n`,
  );
  if (!passed) process.exitCode = 1;
}
