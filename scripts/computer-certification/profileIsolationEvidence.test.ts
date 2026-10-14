import { expect, it } from "vitest";
import { profileIsolationChecks, profileReadinessChecks } from "./profileIsolationEvidence";
const passing = () => {
  const profiles = [0, 1].map(() => ({
    held: false,
    busy: 1,
    busyWhileForeignHeld: true,
    anonymousBanners: 1,
    ownBanners: 1,
    ownActivities: 1,
    ownImages: 1,
    ownWsActivities: 1,
    ownWsImages: 1,
    grants: 1,
    foreignActivity: false,
    foreignImages: false,
    foreignGrants: false,
    foreignIdentity: false,
    invalidBanner: false,
    native: {
      traceComplete: true,
      pendingResponses: 0,
      lastGrantCount: 0,
      operations: [
        { op: "leaseAcquire", outcome: "Busy" },
        { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
      ],
    },
  }));
  const held = { traceComplete: true, profiles: [{ held: false }, { held: true }] };
  return {
    cleanup: { confirmed: true },
    profileIsolationObservation: {
      channels: { configured: true, traceComplete: true, profiles },
      consents: [0, 1].map(() => ({
        trustedReview: true,
        visible: true,
        allowed: true,
        settled: true,
        remembered: false,
      })),
      distinctRendererProfiles: true,
      distinctBackendProcesses: true,
      isolatedProviderHomes: true,
      beforeNonHolderStop: held,
      afterNonHolderStop: structuredClone(held),
      nonHolderSessionStopped: true,
      sourceCredentialsUnchanged: true,
      isolatedCredentialsUnchanged: true,
      profileSnapshotsPrivate: true,
      secondHelperReason: "other-instance",
      bothSessionsStopped: true,
      humanFinishAcknowledged: true,
      fixturesUntouched: true,
      bothChatSurfacesReady: true,
    },
  };
};
it("requires positive image/activity receipts, genuine reviews and exact cleanup in addition to negative privacy flags", () => {
  expect(Object.values(profileIsolationChecks(passing())).every(Boolean)).toBe(true);
  expect(Object.values(profileIsolationChecks({})).every(Boolean)).toBe(false);
  for (const field of [
    "ownImages",
    "ownWsImages",
    "ownActivities",
    "ownWsActivities",
    "grants",
  ] as const) {
    const raw = passing();
    raw.profileIsolationObservation.channels.profiles[1]![field] = 0;
    expect(Object.values(profileIsolationChecks(raw)).every(Boolean)).toBe(false);
  }
});
it("fails when either observation source detects a foreign image, identity or grant", () => {
  for (const field of [
    "foreignImages",
    "foreignActivity",
    "foreignGrants",
    "foreignIdentity",
    "invalidBanner",
  ] as const) {
    const raw = passing();
    raw.profileIsolationObservation.channels.profiles[0]![field] = true;
    expect(Object.values(profileIsolationChecks(raw)).every(Boolean)).toBe(false);
  }
});
it("does not accept sequential activations as real contention", () => {
  const raw = passing();
  const contender = raw.profileIsolationObservation.channels.profiles[1]!;
  contender.busy = 0;
  contender.busyWhileForeignHeld = false;
  contender.native.operations[0] = { op: "leaseAcquire", outcome: "ok" };
  expect(profileIsolationChecks(raw)["lease-contention"]).toBe(false);
});
it("rejects lost traces, changed credentials, unconfirmed cleanup and non-holder stop losing the holder", () => {
  const raw = passing();
  raw.profileIsolationObservation.afterNonHolderStop.profiles[1]!.held = false;
  expect(profileIsolationChecks(raw)["exact-release"]).toBe(false);
  raw.profileIsolationObservation.isolatedCredentialsUnchanged = false;
  expect(profileIsolationChecks(raw)["credential-files-unchanged"]).toBe(false);
  raw.profileIsolationObservation.fixturesUntouched = false;
  expect(profileIsolationChecks(raw)["native-actions"]).toBe(false);
  raw.profileIsolationObservation.channels.traceComplete = false;
  expect(profileIsolationChecks(raw)["no-foreign-images"]).toBe(false);
  raw.cleanup.confirmed = false;
  expect(profileIsolationChecks(raw).cleanup).toBe(false);
});
it("keeps read-only readiness distinct from actual isolation and refuses any native action or grant", () => {
  const profiles = [0, 1].map(() => ({
    held: false,
    ownActivities: 0,
    ownImages: 0,
    native: {
      traceComplete: true,
      pendingResponses: 0,
      accessRequests: 0,
      accessAnswersForwarded: 0,
      leaseObserved: false,
      operations: [{ op: "listApps", outcome: "ok", validApps: true }],
    },
  }));
  const raw = {
    cleanup: { confirmed: true },
    profileIsolationObservation: {
      readinessOnly: true,
      ownerPollingReadOnlyChecked: true,
      bothChatSurfacesReady: true,
      distinctRendererProfiles: true,
      distinctBackendProcesses: true,
      isolatedProviderHomes: true,
      profileSnapshotsPrivate: true,
      sourceCredentialsUnchanged: true,
      isolatedCredentialsUnchanged: true,
      bothSessionsStopped: true,
      channels: { configured: true, traceComplete: true, profiles },
    },
  };
  expect(Object.values(profileReadinessChecks(raw)).every(Boolean)).toBe(true);
  expect(Object.values(profileIsolationChecks(raw)).every(Boolean)).toBe(false);
  raw.profileIsolationObservation.channels.profiles[1]!.native.accessRequests = 1;
  expect(profileReadinessChecks(raw)["no-grant-lease-or-input"]).toBe(false);
  raw.profileIsolationObservation.channels.profiles[1]!.native.accessRequests = 0;
  raw.profileIsolationObservation.channels.profiles[1]!.native.operations[0]!.op = "activateApp";
  expect(profileReadinessChecks(raw)["no-grant-lease-or-input"]).toBe(false);
});
