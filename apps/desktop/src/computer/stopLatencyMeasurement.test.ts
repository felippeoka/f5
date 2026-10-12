import { expect, it } from "vitest";
import { measureStopLatency, type StopLatencyEvidence } from "./stopLatencyMeasurement";

const evidence: StopLatencyEvidence = {
  samples: [
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "injected" as const,
      eventAtMs: 1050 + index * 20,
      observedAtMs: 1051 + index * 20,
      keyDown: true,
    })),
    { kind: "physical", eventAtMs: 1200, observedAtMs: 1202, keyDown: false },
    { kind: "injected", eventAtMs: 1204, observedAtMs: 1205, keyDown: false },
    { kind: "chord", eventAtMs: 1240, observedAtMs: 1242, keyDown: true },
  ],
  physicalRecognizedAtMs: 1200,
  chordRecognizedAtMs: 1240,
  promptAtMs: 1195,
  observationEndedAtMs: 1800,
  mutationInterrupted: true,
  pausedMutationRefused: true,
  leaseReleased: true,
  fixtureStillFrontmost: true,
  overflow: false,
};
it("counts held-input release in the stop tail without retaining key contents", () => {
  expect(measureStopLatency(evidence)).toMatchObject({
    state: "passed",
    physicalInputTailMs: 4,
    killChordTailMs: 0,
    appDeliveryTailMs: 5,
  });
});
it("fails when any input emission or app delivery reaches the 100 ms boundary", () => {
  for (const sample of [
    { kind: "injected" as const, eventAtMs: 1300, observedAtMs: 1301, keyDown: true },
    { kind: "injected" as const, eventAtMs: 1204, observedAtMs: 1300, keyDown: false },
  ])
    expect(measureStopLatency({ ...evidence, samples: [...evidence.samples, sample] }).state).toBe(
      "failed",
    );
});
it("does not certify missing samples, recognition or an incomplete chord", () => {
  for (const change of [
    { samples: [] },
    { physicalRecognizedAtMs: undefined },
    { chordRecognizedAtMs: undefined },
    { samples: evidence.samples.filter((sample) => sample.kind !== "chord") },
    {
      samples: evidence.samples.map((sample) => ({
        ...sample,
        eventAtMs: sample.eventAtMs - 2000,
      })),
    },
    { observationEndedAtMs: 1500 },
    { overflow: true },
    { mutationInterrupted: false },
    { pausedMutationRefused: false },
    { fixtureStillFrontmost: false },
  ])
    expect(measureStopLatency({ ...evidence, ...change } as StopLatencyEvidence).state).toBe(
      "failed",
    );
});
it("requires the whole physical chord to fall inside conservative host-stall clock bounds", () => {
  const hostStall = { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1002 };
  expect(measureStopLatency({ ...evidence, hostStall }).state).toBe("passed");
  for (const changed of [
    { ...hostStall, startMs: 199 },
    { ...hostStall, endMs: 239 },
    { ...hostStall, offsetMaxMs: 1030 },
    { ...hostStall, endMs: 50 },
  ])
    expect(measureStopLatency({ ...evidence, hostStall: changed }).state).toBe("failed");
});
it("requires input to have been active near recognition and the prompt already visible", () => {
  expect(measureStopLatency({ ...evidence, promptAtMs: 1201 }).state).toBe("failed");
  expect(
    measureStopLatency({
      ...evidence,
      samples: evidence.samples.map((sample) =>
        sample.kind === "injected" ? { ...sample, eventAtMs: 800, observedAtMs: 801 } : sample,
      ),
    }).state,
  ).toBe("failed");
});
it("requires the backend to remain stopped when that mode is selected", () => {
  expect(measureStopLatency({ ...evidence, backendFrozenAtStop: true }).state).toBe("passed");
  expect(measureStopLatency({ ...evidence, backendFrozenAtStop: false }).state).toBe("failed");
});
