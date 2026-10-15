import { describe, expect, it } from "vitest";
import { RpcAdmission, rpcLane, isReadOnlyRpc } from "./rpcScheduling";

describe("RPC admission", () => {
  it("reserves controls independently of eight occupied ordinary slots", () => {
    const admission = new RpcAdmission();
    const releases = Array.from({ length: 8 }, () => admission.claim("ordinary", 1024));
    expect(releases.every(Boolean)).toBe(true);
    expect(admission.claim("ordinary", 1)).toBeNull();
    expect(admission.claim("stop", 1024)).not.toBeNull();
    expect(admission.claim("answer", 1024)).not.toBeNull();
    expect(admission.claim("answer", 1024)).not.toBeNull();
    expect(admission.claim("answer", 1)).toBeNull();
    releases[0]!();
    releases[0]!();
    expect(admission.claim("ordinary", 1024)).not.toBeNull();
    expect(admission.claim("ordinary", 1024)).toBeNull();
  });
  it("accepts legal 20 MiB frames and bounds retained ordinary bytes at 80 MiB", () => {
    const admission = new RpcAdmission();
    for (let i = 0; i < 4; i++)
      expect(admission.claim("ordinary", 20 * 1024 * 1024)).not.toBeNull();
    expect(admission.claim("ordinary", 1)).toBeNull();
    expect(admission.claim("stop", 1)).not.toBeNull();
  });
  it("classifies nested dispatch commands", () => {
    expect(
      rpcLane({
        _tag: "orchestration.dispatchCommand",
        command: { type: "thread.turn.interrupt" },
      }),
    ).toBe("stop");
    for (const type of [
      "thread.approval.respond",
      "thread.user-input.respond",
      "thread.turn.steer",
    ])
      expect(rpcLane({ _tag: "orchestration.dispatchCommand", command: { type } })).toBe("answer");
    expect(rpcLane({ _tag: "orchestration.getStartupSnapshot" })).toBe("recovery");
    expect(
      rpcLane({ _tag: "orchestration.dispatchCommand", command: { type: "thread.turn.start" } }),
    ).toBe("ordinary");
  });
});

it("keeps ordinary thread reads out of the snapshot lane and admits queue steering", () => {
  for (const method of [
    "orchestration.getThreadDetails",
    "orchestration.getThreadTailDetails",
    "orchestration.getThreadHistoryPage",
    "orchestration.getThreadCommandExecutions",
    "orchestration.getThreadFileChanges",
  ])
    expect(rpcLane({ _tag: method })).toBe("ordinary");
  const admission = new RpcAdmission();
  for (let i = 0; i < 8; i++) admission.claim("ordinary", 1);
  expect(admission.claim(rpcLane({ _tag: "nextTurnQueue.steer" }), 1)).not.toBeNull();
});

it("allows only explicitly audited reads during recovery", () => {
  for (const method of [
    "providerAccount.logout",
    "providerAccount.loginStart",
    "githubAccount.loginStart",
    "githubAccount.loginCancel",
    "nativeOperation.resolve",
    "unknown.getAnything",
  ])
    expect(isReadOnlyRpc(method)).toBe(false);
  for (const method of [
    "terminal.snapshot",
    "review.previewDiff",
    "nextTurnQueue.summary",
    "globalSearch.query",
    "projects.cloneList",
    "githubAccount.cliCandidates",
  ])
    expect(isReadOnlyRpc(method)).toBe(true);
});
