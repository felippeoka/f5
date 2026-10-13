import { record, digest } from "./model";
import type { Manifest, ScenarioResult } from "./model";
import type { ScenarioInstance } from "./catalog";

const safeKey = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,100}$/;
function checksOf(raw: unknown): Record<string, boolean> {
  if (!record(raw) || Object.keys(raw).length > 256) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([key, v]) => safeKey.test(key) && typeof v === "boolean"),
  ) as Record<string, boolean>;
}
/** Whitelist summaries; raw tool IO, titles, text, error strings and images never enter the suite. */
export function summarizeEvidence(scenario: ScenarioInstance, manifest: Manifest, raw: unknown) {
  if (
    !record(raw) ||
    raw.reportVersion !== 1 ||
    raw.platform !== manifest.identity.platform ||
    raw.helperSha256 !== manifest.identity.files.helper
  )
    throw new Error("Evidence identity mismatch");
  let checks: Record<string, boolean> = {};
  const phase = record(raw.phaseEvidence)
    ? raw.phaseEvidence[scenario.id === "real-apps" ? "realApps" : "fixture"]
    : undefined;
  const assertions = record(phase) ? phase.checks : raw.checks;
  let passed =
    (record(phase) ? phase.state : raw.state) === "passed" &&
    !raw.interrupted &&
    !raw.physicalInterruption;
  if (Array.isArray(raw.checks)) {
    if (raw.checks.length > 64 || !raw.checks.every(record))
      throw new Error("Invalid native check list");
    checks = Object.fromEntries(
      raw.checks.map((c, i) => ["native-" + (i + 1), c.state === "passed"]),
    );
    // Pin known complete scenarios. A single passing marker cannot stand in for the matrix.
    const expectedCount =
      scenario.id === "protected-apps" ? 13 : scenario.id === "capture" ? 7 : undefined;
    passed =
      !raw.failure &&
      !raw.failureStage &&
      !raw.physicalInterruption &&
      expectedCount !== undefined &&
      raw.checks.length === expectedCount &&
      Object.values(checks).every(Boolean);
  } else {
    checks = checksOf(assertions);
    // Don't silently discard malformed assertion values.
    if (!record(assertions) || Object.keys(checks).length !== Object.keys(assertions).length)
      passed = false;
    passed &&= scenario.expectedChecks.every((key) => checks[key] === true);
  }
  const stop = record(raw.stopMeasurement)
    ? raw.stopMeasurement
    : record(raw.measurement)
      ? raw.measurement
      : undefined;
  const measurements: Record<string, number> = {};
  if (stop) {
    const stopChecks = checksOf(stop.checks);
    for (const [key, value] of Object.entries(stopChecks)) checks["stop." + key] = value;
    passed =
      stop.state === "passed" &&
      Object.keys(stopChecks).length >= 16 &&
      Object.values(stopChecks).every(Boolean) &&
      !raw.failure &&
      !raw.interrupted;
    for (const key of [
      "physicalInputTailMs",
      "killChordTailMs",
      "appDeliveryTailMs",
      "hostStallDurationMs",
      "rendererFreezeDurationMs",
      "clockUncertaintyMs",
      "injectedKeyDowns",
    ]) {
      if (typeof stop[key] === "number" && Number.isFinite(stop[key]) && stop[key] >= 0)
        measurements[key] = stop[key];
    }
    for (const key of ["physicalInputTailMs", "killChordTailMs", "appDeliveryTailMs"])
      passed &&= typeof measurements[key] === "number" && measurements[key]! < 100;
  }
  const cleanup =
    record(raw.cleanup) && raw.cleanup.confirmed === true ? "confirmed" : "unconfirmed";
  passed &&=
    cleanup === "confirmed" &&
    Object.keys(checks).length > 0 &&
    Object.values(checks).every(Boolean);
  return {
    state: passed ? ("passed" as const) : ("failed" as const),
    checks,
    measurements,
    cleanup,
    evidenceKind: scenario.provider ? ("provider-desktop" as const) : ("native-helper" as const),
    evidenceSha256: digest(raw),
    ...(passed
      ? {}
      : { reason: cleanup !== "confirmed" ? "cleanup-unconfirmed" : "assertion-incomplete" }),
  } satisfies Pick<
    ScenarioResult,
    "state" | "checks" | "measurements" | "cleanup" | "evidenceKind" | "evidenceSha256" | "reason"
  >;
}
