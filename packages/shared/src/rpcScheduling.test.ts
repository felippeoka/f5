import { describe, expect, it } from "vitest";
import { RpcAdmission, rpcLane } from "./rpcScheduling";

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
