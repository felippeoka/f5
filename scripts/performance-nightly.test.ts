import { expect, it } from "vitest";
import { nightlyBaselineDecision } from "./performance-nightly.ts";
import type { PerformanceReport } from "./lib/performance/report.ts";
function report(): PerformanceReport {
  return {
    schemaVersion: 1,
    scope: "server-component",
    mode: "measurement",
    metadata: {
      fixtureDigest: "fixture",
      harnessDigest: "harness",
      hardware: {},
      os: {},
      runtime: { versions: { node: "24.13.1", bun: "1.3.9" } },
    } as PerformanceReport["metadata"],
    method: { warmups: 5, repetitions: 30 },
    measurements: { sample: { wallMs: Array(30).fill(1), cpuMs: Array(30).fill(1) } },
    observations: [],
    notMeasured: ["browser"],
  };
}
it("initializes, resets or re-baselines incompatible metadata and compares compatible reports", () => {
  expect(nightlyBaselineDecision(report()).replace).toBe(true);
  expect(nightlyBaselineDecision(report(), report(), true).replace).toBe(true);
  expect(nightlyBaselineDecision(report(), report()).replace).toBe(false);
  for (const key of [
    "fixtureDigest",
    "harnessDigest",
    "hardware",
    "os",
    "gitVersion",
    "browser",
    "browserConfig",
  ] as const) {
    const candidate = report();
    Object.assign(candidate.metadata, { [key]: "changed" });
    expect(nightlyBaselineDecision(candidate, report())).toMatchObject({
      replace: true,
      reason: expect.stringContaining("incompatible"),
    });
  }
  const candidate = report();
  candidate.metadata.runtime.versions.node = "changed";
  expect(nightlyBaselineDecision(candidate, report()).replace).toBe(true);
  expect(() => nightlyBaselineDecision({ ...report(), mode: "smoke" })).toThrow(
    "full server measurements",
  );
});
