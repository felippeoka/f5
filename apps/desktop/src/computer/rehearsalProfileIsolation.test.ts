import { expect, it } from "vitest";
import { RehearsalProfileIsolation } from "./rehearsalProfileIsolation";
const identities = [0, 1].map((i) => ({
  profileId: String(i + 1).repeat(32),
  threadId: `PRIVATE_THREAD_${i}`,
  appId: `private.fixture.${i}`,
  privateTitle: `PRIVATE_TITLE_${i}`,
}));
const configured = () => {
  const o = new RehearsalProfileIsolation();
  o.configure(identities);
  return o;
};
const holder = (i: number) => ({
  profileId: identities[i]!.profileId,
  threadId: identities[i]!.threadId,
  sessionGeneration: `session-${i}`,
  turnId: `turn-${i}`,
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
  backend: "native",
  threadTitle: identities[i]!.privateTitle,
});
const activity = (i: number) => ({
  threadId: identities[i]!.threadId,
  backend: "native",
  op: "activateApp",
  status: "completed",
  thumbnailDataUrl: "PRIVATE_IMAGE_BYTES",
});
it("correlates both IPC directions and client observations without retaining identities or pixels", () => {
  const o = configured();
  o.receive(identities[0]!.profileId, { type: "leaseChanged", holder: holder(0) }, "main");
  o.receive(
    identities[1]!.profileId,
    { type: "leaseChanged", holder: null, otherProfile: true },
    "main",
  );
  o.receive(
    identities[1]!.profileId,
    { type: "response", requestId: "opaque", error: { _tag: "Busy", holder: "other-profile" } },
    "main",
  );
  o.receive(identities[0]!.profileId, { type: "activity", activity: activity(0) }, "main");
  o.push(0, "computer.activity", activity(0));
  o.push(0, "computer.access.grantsChanged", {
    threadId: identities[0]!.threadId,
    grants: [{ appId: identities[0]!.appId }],
  });
  const s = o.snapshot();
  expect(s.traceComplete).toBe(true);
  expect(s.profiles[0]).toMatchObject({
    ownImages: 1,
    ownWsImages: 1,
    foreignImages: false,
    foreignGrants: false,
  });
  expect(s.profiles[1]).toMatchObject({ anonymousBanners: 1, busy: 1, busyWhileForeignHeld: true });
  expect(JSON.stringify(s)).not.toContain("PRIVATE");
  expect(JSON.stringify(s)).not.toContain("private.fixture");
});
it.each(["ipc", "websocket"])(
  "detects a foreign thumbnail on %s before discarding it",
  (channel) => {
    const o = configured();
    if (channel === "ipc")
      o.receive(identities[1]!.profileId, { type: "activity", activity: activity(0) }, "main");
    else o.push(1, "computer.activity", activity(0));
    expect(o.snapshot().profiles[1]).toMatchObject({
      foreignActivity: true,
      foreignImages: true,
      foreignIdentity: true,
    });
    expect(JSON.stringify(o.snapshot())).not.toContain("PRIVATE");
  },
);
it("rejects named cross-profile banners and grant contents", () => {
  const o = configured();
  o.receive(
    identities[1]!.profileId,
    { type: "leaseChanged", holder: holder(0), otherProfile: true },
    "main",
  );
  o.push(1, "agent.computerUseChanged", {
    threadId: null,
    otherProfile: true,
    title: "PRIVATE_TITLE_0",
  });
  o.push(1, "computer.access.grantsChanged", {
    threadId: identities[1]!.threadId,
    grants: [{ appId: identities[0]!.appId }],
  });
  expect(o.snapshot().profiles[1]).toMatchObject({
    invalidBanner: true,
    foreignIdentity: true,
    foreignGrants: true,
  });
});
it("does not count contention when no foreign holder was observed", () => {
  const o = configured();
  o.receive(
    identities[1]!.profileId,
    { type: "response", requestId: "opaque", error: { _tag: "Busy", holder: "other-profile" } },
    "main",
  );
  expect(o.snapshot().profiles[1]?.busyWhileForeignHeld).toBe(false);
});
it("also detects foreign orchestration identities without retaining message content", () => {
  const o = configured();
  o.push(1, "orchestration.domainEvent", {
    payload: { threadId: identities[0]!.threadId, text: "PRIVATE_MESSAGE" },
  });
  expect(o.snapshot().profiles[1]?.foreignIdentity).toBe(true);
  expect(JSON.stringify(o.snapshot())).not.toContain("PRIVATE");
});
it("fails closed on unknown origins, malformed packets and bounded observation overflow", () => {
  for (const input of ["unknown", "malformed", "overflow"]) {
    const o = configured();
    if (input === "unknown") o.receive("unexpected", { type: "heartbeat" }, "main");
    else if (input === "malformed")
      o.receive(identities[0]!.profileId, { type: "response" }, "main");
    else for (let n = 0; n <= 4096; n++) o.push(0, "computer.activity", activity(0));
    expect(o.snapshot().traceComplete).toBe(false);
  }
  const o = configured();
  expect(() => o.configure(identities)).toThrow();
});
