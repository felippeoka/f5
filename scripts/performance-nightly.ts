import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { compareReportMetadata, type PerformanceReport } from "./lib/performance/report.ts";

export function nightlyBaselineDecision(
  candidate: PerformanceReport,
  baseline?: PerformanceReport,
  reset = false,
) {
  if (
    candidate.scope !== "server-component" ||
    candidate.mode !== "measurement" ||
    candidate.method.warmups !== 5 ||
    candidate.method.repetitions !== 30
  )
    throw new Error(
      "Nightly baselines require full server measurements (5 warmups, 30 repetitions).",
    );
  if (reset) return { replace: true, reason: "Baseline reset requested." };
  if (!baseline)
    return { replace: true, reason: "No baseline available; recorded candidate as baseline." };
  const incompatibilities = compareReportMetadata(baseline, candidate);
  if (incompatibilities.length)
    return {
      replace: true,
      reason: `Baseline incompatible, re-baselined: ${incompatibilities.join(", ")}`,
    };
  return { replace: false, reason: "Compared candidate with compatible baseline." };
}
if (import.meta.main) {
  const candidatePath = process.argv[2] ?? ".performance/candidate.json";
  const baselinePath = process.argv[3] ?? ".performance/baseline/candidate.json";
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as PerformanceReport;
  const decision = nightlyBaselineDecision(
    read(candidatePath),
    existsSync(baselinePath) ? read(baselinePath) : undefined,
    process.env.RESET_BASELINE === "true",
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `replace-baseline=${decision.replace}\n`);
  let summary = decision.reason + "\n";
  console.log(decision.reason);
  if (!decision.replace) {
    const comparison = spawnSync("bun", ["run", "perf:compare", baselinePath, candidatePath], {
      encoding: "utf8",
    });
    const output = `${comparison.stdout ?? ""}${comparison.stderr ?? ""}`;
    console.log(output);
    summary += `\n\`\`\`text\n${output}\n\`\`\`\n`;
    if (comparison.error) throw comparison.error;
    process.exitCode = comparison.status ?? 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
