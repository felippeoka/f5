import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { inventories } from "./ci-test-summary.ts";

interface Job {
  needs?: string[];
  if?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  concurrency?: unknown;
  strategy?: { matrix?: unknown; "fail-fast"?: boolean };
}
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };

export function assertWorkflowPolicy(jobs: Record<string, Job>) {
  const gated = Object.keys(jobs).filter((id) => !["ci-result", "main-status"].includes(id));
  expect([...(jobs["ci-result"]?.needs ?? [])].sort()).toEqual(gated.sort());
  expect(jobs["ci-result"]?.if).toBe("always()");
  for (const id of gated) expect(jobs[id]?.["continue-on-error"], id).toBeUndefined();
  for (const [id, job] of Object.entries(jobs)) {
    expect(job["timeout-minutes"], id).toBeGreaterThan(0);
    if (job.strategy?.matrix) expect(job.strategy["fail-fast"], id).toBe(false);
  }
}

describe("CI workflow policy", () => {
  it("gates every job and bounds all jobs and matrices", () => assertWorkflowPolicy(workflow.jobs));
  it("has a report inventory for every configured server unit shard", () => {
    for (const job of ["server-unit", "windows-server-unit"]) {
      const matrix = workflow.jobs[job]!.strategy!.matrix as { shard: number[] };
      for (const shard of matrix.shard) {
        const event = `server-unit-${shard}`;
        expect(inventories[event]).toEqual([{ packageName: "suites", event }]);
      }
    }
  });
  it("keeps the notifier outside concurrency groups that can cancel push runs", () => {
    expect(workflow.jobs["main-status"]!.concurrency).toBeUndefined();
  });
  it("rejects a job missing from CI result", () => {
    const jobs = structuredClone(workflow.jobs);
    jobs["ci-result"]!.needs = jobs["ci-result"]!.needs!.filter((id) => id !== "browser");
    expect(() => assertWorkflowPolicy(jobs)).toThrow();
  });
});
