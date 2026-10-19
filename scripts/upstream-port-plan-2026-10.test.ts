import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeAudit, sha256, validateAudit, type Ledger } from "./upstream-port-ledger.ts";
import { applyPortPlan, type PortPlan } from "./upstream-port-plan.ts";

const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const plan = read("./upstream-port-plan-2026-10.json") as PortPlan;
const september = read("./upstream-port-plan-2026-09.json") as PortPlan;
const ledger = read("./upstream-ports.json") as Ledger;
const bySha = new Map(ledger.entries.map((entry) => [entry.upstreamSha, entry]));
const commits = (artifact: PortPlan) =>
  artifact.entries.map((entry) => ({
    sha: entry.upstreamSha,
    subject: bySha.get(entry.upstreamSha)!.subject,
  }));
const digest = (shas: ReadonlyArray<string>) => sha256(shas.join("\n") + "\n");

describe("October 2026 classification artifact", () => {
  it("pins the complete independently selected interval in newest-first order", () => {
    expect(plan.baseSha).toBe("f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc");
    expect(plan.targetSha).toBe("da7c4f234db35096af2c16d5e24c60dbe9495583");
    const shas = plan.entries.map((entry) => entry.upstreamSha);
    expect(shas).toHaveLength(1752);
    expect(new Set(shas).size).toBe(1752);
    expect(digest(shas)).toBe("863fdeb7e3232508be82ddc98dd7b861325e921565089c6d3eb9b5b3b2468100");
    expect(ledger.intervals[1]).toEqual(makeAudit(plan.baseSha, plan.targetSha, shas));
    expect(ledger.entries).toHaveLength(4084);
    expect(validateAudit(ledger)).toEqual([]);
  });

  it("carries every one of the frozen 299 September members exactly once", () => {
    const groups = plan.septemberCarriers!;
    const shas = Object.values(groups).flatMap((group) => group.upstreamShas);
    expect(shas).toHaveLength(299);
    expect(new Set(shas).size).toBe(299);
    expect(digest([...shas].sort())).toBe(
      "4f6231f46344259953bb78400a81fd22d106613aa954cd38ebe99e4f822003ed",
    );
    for (const [group, carrier] of Object.entries(groups)) {
      const workstream = group.split(":")[0];
      for (const sha of carrier.upstreamShas) {
        // Delivery may change disposition; it must never erase the September id.
        expect(bySha.get(sha)?.plannedWorkstream).toBe(workstream);
      }
    }
    expect(groups["2"]?.carrierWorkstream).toBe("15a");
    expect(groups["10"]?.carrierWorkstream).toBe("15o");
    expect(groups["11a"]?.carrierWorkstream).toBe("15q");
    expect(groups["11c"]?.carrierWorkstream).toBe("15t");
    expect(groups["12a"]?.carrierWorkstream).toBe("15j");
    expect(groups["12b"]?.carrierWorkstream).toBe("15j");
    for (const id of ["13a", "13b", "14"]) expect(groups[id]?.carrierWorkstream).toBe("15s");
    expect(groups["3e"]?.carrierWorkstream).toBe("15o");
    expect(groups["11"]?.carrierWorkstream).toBe("15t");
    expect(groups["13d:preview"]?.upstreamShas).toEqual([
      "a43f9b45ae85caf37e0be8270ad3d27365ece2bd",
    ]);
    expect(groups["13d:deferred"]?.upstreamShas).toHaveLength(2);
    expect(groups["13d:deferred"]?.carrierWorkstream).toBeNull();
  });

  it("restores all 26 settlement decisions after September is reapplied", () => {
    const original = september.entries.filter(
      (entry) =>
        entry.classification === "not-applicable:upstream-only-subsystem:thread-settlement",
    );
    expect(plan.priorIntervalOverrides).toHaveLength(26);
    expect(plan.priorIntervalOverrides!.map((entry) => entry.upstreamSha).sort()).toEqual(
      original.map((entry) => entry.upstreamSha).sort(),
    );
    const reapplied = applyPortPlan(
      applyPortPlan(ledger, commits(september), september),
      commits(plan),
      plan,
    );
    for (const override of plan.priorIntervalOverrides!) {
      expect(override).toMatchObject({
        classification: "planned:15c",
        reason: "Reclassified 2026-10 by user decision",
      });
      const entry = reapplied.entries.find((entry) => entry.upstreamSha === override.upstreamSha)!;
      if (entry.disposition !== "ported")
        expect(entry).toMatchObject({ disposition: "deferred", plannedWorkstream: "15c" });
    }
  });

  it("preserves completed proof for both interval entries and prior-interval overrides", () => {
    const selected = new Set([
      plan.entries[0]!.upstreamSha,
      plan.priorIntervalOverrides![0]!.upstreamSha,
    ]);
    const completed: Ledger = {
      ...ledger,
      entries: ledger.entries.map((entry) =>
        selected.has(entry.upstreamSha)
          ? {
              ...entry,
              disposition: "ported",
              f5Shas: ["0b07438184417a6f82f91105609d8b404d8ae643"],
              evidence: ["scripts/upstream-port-plan.ts:1"],
            }
          : entry,
      ),
    };
    const reapplied = applyPortPlan(
      applyPortPlan(completed, commits(september), september),
      commits(plan),
      plan,
    );
    for (const entry of completed.entries) {
      if (["ported", "equivalent", "already-present"].includes(entry.disposition))
        expect(
          reapplied.entries.find((candidate) => candidate.upstreamSha === entry.upstreamSha),
        ).toEqual(entry);
    }
    expect(reapplied.intervals).toEqual(ledger.intervals);
    expect(reapplied.legacyCoverage).toEqual(ledger.legacyCoverage);
  });

  it("rejects a deleted classification and invalid override coverage", () => {
    const removed = plan.entries[1000]!;
    expect(() =>
      applyPortPlan(ledger, commits(plan), {
        ...plan,
        entries: plan.entries.filter((entry) => entry !== removed),
      }),
    ).toThrow(`missing SHAs: ${removed.upstreamSha}`);
    expect(() =>
      applyPortPlan(ledger, commits(plan), { ...plan, priorIntervalOverrides: [plan.entries[0]!] }),
    ).toThrow("must belong to a prior interval");
    expect(() =>
      applyPortPlan(ledger, commits(plan), {
        ...plan,
        priorIntervalOverrides: [
          plan.priorIntervalOverrides![0]!,
          plan.priorIntervalOverrides![0]!,
        ],
      }),
    ).toThrow("duplicate prior-interval override");
  });

  it("keeps source-inspected Lineage and relay changes outside the native Agents workstream", () => {
    const decisions = new Map(plan.entries.map((entry) => [entry.upstreamSha, entry]));
    expect(decisions.get("d3071275d576bb289a6cb177c6cc28fff8e95015")?.classification).toBe(
      "not-applicable:upstream-only-subsystem:lineage-delegation",
    );
    expect(decisions.get("d668ffcd64d74daba16520cbbfb0fdb431983eac")?.classification).toBe(
      "not-applicable:relay-cloud",
    );
    for (const sha of [
      "d3071275d576bb289a6cb177c6cc28fff8e95015",
      "d668ffcd64d74daba16520cbbfb0fdb431983eac",
      "1550058056ba660b8581c8eda990c9d40c493a4b",
      "22af947e0d353c9e89c6db2a268836baa71bece5",
    ])
      expect(bySha.get(sha)?.disposition).toBe("not-applicable");
  });

  it("records the unsupported OpenCode 2 inbox scenario separately from shared provider review", () => {
    const sha = "dd4549eede928f9dc514778aeae15d74656a87f8";
    expect(plan.entries.find((entry) => entry.upstreamSha === sha)?.classification).toBe(
      "not-applicable:upstream-only-subsystem:opencode-2-inbox",
    );
    expect(bySha.get(sha)?.disposition).toBe("not-applicable");
  });

  it("names a verification scenario and target for every planned decision", () => {
    for (const entry of [...plan.entries, ...plan.priorIntervalOverrides!]) {
      if (!entry.classification.startsWith("planned:")) continue;
      expect(entry.verification?.scenarioIds.length, entry.upstreamSha).toBeGreaterThan(0);
      expect(entry.verification?.targetModules.length, entry.upstreamSha).toBeGreaterThan(0);
    }
  });
});
