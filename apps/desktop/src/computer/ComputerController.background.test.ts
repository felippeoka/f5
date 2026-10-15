import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ComputerAuthorization,
  ComputerAutomationRequest,
  ComputerLeaseHolder,
} from "@t3tools/contracts";
import { computerRequestPayload } from "@t3tools/shared/computerControl";
import { ComputerController } from "./ComputerController";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import type { ComputerHelper } from "./ComputerHelperClient";

const base: ComputerAuthorization = {
  profileId: "p",
  threadId: "a",
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
function holderFor(threadId: string, appId: string): ComputerLeaseHolder {
  return {
    ...base,
    threadId,
    backend: "native",
    threadTitle: threadId,
    scope: { kind: "app", appId },
    policyRevision: 0,
  };
}
function make(options: { capable?: boolean } = {}) {
  let event: (message: Record<string, unknown>) => void = () => {};
  const request = vi.fn(
    async (_request: ComputerAutomationRequest): Promise<unknown> => ({ ok: true }),
  );
  const helper: ComputerHelper = {
    status: vi.fn((): ReturnType<ComputerHelper["status"]> => ({ available: true, displays: [] })),
    request,
    control: vi.fn(),
    suspend: vi.fn(async () => {}),
    onEvent: (callback) => {
      event = callback;
      return () => {};
    },
    capabilities: () => (options.capable === false ? [] : ["background-ax-v1"]),
    drain: vi.fn(async () => {}),
  };
  const lease = new ComputerLeaseAuthority();
  const paused = vi.fn();
  const states = vi.fn();
  const overlay = {
    show: vi.fn(),
    clear: vi.fn(),
    action: vi.fn(async () => {}),
    windowIds: () => [],
  };
  const controller = new ComputerController(lease, helper, overlay, {
    f5Pids: () => [1],
    f5BundlePath: "F5",
    platform: "darwin",
    activity: vi.fn(),
    paused,
    backgroundAvailable: () => true,
    executionState: states,
    takeoverValid: () => true,
  });
  for (const threadId of ["a", "b"]) controller.updateGrants({ ...base, threadId });
  return {
    controller,
    helper,
    request,
    lease,
    paused,
    states,
    overlay,
    event: (message: Record<string, unknown>) => event(message),
  };
}
function envelope(
  id: string,
  holder: ComputerLeaseHolder,
  extras: Record<string, unknown> = {},
): ComputerAutomationRequest {
  const { backend: _backend, threadTitle: _title, scope, policyRevision: _rev, ...auth } = holder;
  const value = {
    requestId: id,
    authorization: auth,
    deadlineAtMs: Date.now() + 10000,
    agent: { provider: "claude", threadTitle: holder.threadTitle },
    op: "elementAction",
    appId: scope.kind === "app" ? scope.appId : undefined,
    snapshotId: "snapshot",
    elementRef: "ref",
    action: "press",
    delivery: "background",
    ...extras,
  } as Omit<ComputerAutomationRequest, "payloadHash">;
  return {
    ...value,
    payloadHash: createHash("sha256").update(computerRequestPayload(value)).digest("hex"),
  } as ComputerAutomationRequest;
}

describe("background computer control", () => {
  it("lets two threads hold two apps and stops only the conflicting one", async () => {
    const h = make();
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      const b = h.controller.acquire(holderFor("b", "com.apple.TextEdit"));
      expect(h.lease.holders()).toHaveLength(2);
      expect(h.overlay.show).not.toHaveBeenCalled();
      // Generic input never pauses background holders.
      h.event({ type: "physicalInput" });
      expect(h.lease.holders()).toHaveLength(2);
      h.event({ type: "physicalInput", executionGeneration: a.executionGeneration });
      expect(h.lease.holders()).toEqual([b]);
      expect(h.paused).toHaveBeenCalledExactlyOnceWith(a, "user-input");
      expect(h.helper.control).toHaveBeenCalledWith({
        type: "retire",
        executionGeneration: a.executionGeneration,
      });
      await expect(h.controller.invoke(envelope("b1", b))).resolves.toEqual({ ok: true });
      h.event({ type: "killSwitch" });
      expect(h.lease.holders()).toEqual([]);
    } finally {
      h.controller.close();
    }
  });
  it("runs generations concurrently but each generation serially", async () => {
    const h = make();
    const finishes: Array<() => void> = [];
    h.request.mockImplementation(
      () => new Promise((resolve) => finishes.push(() => resolve({ ok: true }))),
    );
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      const b = h.controller.acquire(holderFor("b", "com.apple.TextEdit"));
      const first = h.controller.invoke(envelope("a1", a));
      const second = h.controller.invoke(envelope("a2", a));
      const other = h.controller.invoke(envelope("b1", b));
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
      expect(h.request.mock.calls.map(([request]) => request.requestId)).toEqual(["a1", "b1"]);
      finishes.shift()!();
      await first;
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(3));
      finishes.forEach((finish) => finish());
      await Promise.all([second, other]);
    } finally {
      h.controller.close();
    }
  });
  it("classifies foreground-only operations and scope mismatches before dispatch", async () => {
    const h = make();
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      await expect(
        h.controller.invoke(envelope("focus", a, { action: "focus" })),
      ).rejects.toMatchObject({
        error: { _tag: "ForegroundRequired", reason: "unsupported-in-background" },
      });
      await expect(
        h.controller.invoke(
          envelope("activate", a, {
            op: "activateApp",
            snapshotId: undefined,
            elementRef: undefined,
            action: undefined,
          }),
        ),
      ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
      await expect(
        h.controller.invoke(envelope("wrong-app", a, { appId: "com.apple.TextEdit" })),
      ).rejects.toMatchObject({ error: { _tag: "ReplayRejected" } });
      // A foreground request can never execute under a background scope.
      await expect(
        h.controller.invoke(envelope("foreground", a, { delivery: "foreground" })),
      ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      h.controller.close();
    }
  });
  it("refuses background scopes without capability or while the target is frontmost", () => {
    const legacy = make({ capable: false });
    try {
      expect(() => legacy.controller.acquire(holderFor("a", "com.apple.calculator"))).toThrow(
        expect.objectContaining({ error: expect.objectContaining({ _tag: "ForegroundRequired" }) }),
      );
    } finally {
      legacy.controller.close();
    }
    const h = make();
    try {
      h.event({ type: "heartbeat", frontmostAppId: "com.apple.calculator" });
      expect(() => h.controller.acquire(holderFor("a", "com.apple.calculator"))).toThrow(
        expect.objectContaining({ error: { _tag: "TargetBlocked", kind: "user-active" } }),
      );
      // Non-latching: the thread is not paused.
      expect(h.paused).not.toHaveBeenCalled();
      h.event({ type: "heartbeat", frontmostAppId: "com.apple.finder" });
      expect(h.controller.acquire(holderFor("a", "com.apple.calculator")).threadId).toBe("a");
    } finally {
      h.controller.close();
    }
  });
  it("replays across generations without a second helper call", async () => {
    const h = make();
    try {
      const first = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      const request = envelope("once", first);
      await h.controller.invoke(request);
      // Scope change in the same session and turn issues a new generation.
      const second = h.controller.acquire(holderFor("a", "com.apple.TextEdit"));
      expect(second.executionGeneration).toBeGreaterThan(first.executionGeneration);
      await expect(h.controller.invoke(request)).rejects.toMatchObject({
        error: { _tag: "ReplayRejected" },
      });
      expect(h.request).toHaveBeenCalledTimes(1);
    } finally {
      h.controller.close();
    }
  });
  it("pauses on target interruption and activation incidents", () => {
    const h = make();
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      const b = h.controller.acquire(holderFor("b", "com.apple.TextEdit"));
      h.event({ type: "targetInterrupted", executionGeneration: a.executionGeneration });
      h.event({ type: "activationIncident", executionGeneration: b.executionGeneration });
      expect(h.paused.mock.calls.map(([holder, cause]) => [holder.threadId, cause])).toEqual([
        ["a", "target-active"],
        ["b", "activation"],
      ]);
      expect(h.states).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ threadId: "a", state: "paused", pauseCause: "target-active" }),
      );
    } finally {
      h.controller.close();
    }
  });
  it("quarantines a target after an unknown outcome until a local resume", async () => {
    const h = make();
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      h.request.mockRejectedValueOnce(
        new (await import("@t3tools/shared/computerControl")).ComputerControlError({
          _tag: "OutcomeUnknown",
        }),
      );
      await expect(h.controller.invoke(envelope("unknown", a))).rejects.toMatchObject({
        error: { _tag: "OutcomeUnknown" },
      });
      expect(h.states).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ state: "recovery", pauseCause: "outcome-unknown" }),
      );
      expect(h.controller.resumeTarget("p", "a").recovery).toBe(true);
      expect(() => h.controller.acquire(holderFor("a", "com.apple.calculator"))).toThrow();
      h.controller.setPaused("p", "a", false);
      expect(h.controller.resumeTarget("p", "a").recovery).toBe(false);
      expect(h.controller.acquire(holderFor("a", "com.apple.calculator")).threadId).toBe("a");
    } finally {
      h.controller.close();
    }
  });
  it("puts a cancelled dispatched mutation into recovery and keeps its app excluded until the helper answers", async () => {
    const h = make();
    let answer: (value: unknown) => void = () => {};
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      const pending = h.controller.invoke(envelope("slow", a));
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
      h.controller.cancel("slow", "p");
      await expect(pending).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
      expect(h.controller.resumeTarget("p", "a")).toMatchObject({
        pauseCause: "outcome-unknown",
        recovery: true,
      });
      expect(h.lease.holders()).toEqual([]);
      // Released, but the helper may still be acting in that app.
      expect(() => h.controller.acquire(holderFor("b", "com.apple.calculator"))).toThrow(
        /foreground-busy/,
      );
      // Unrelated apps are unaffected.
      expect(h.controller.acquire(holderFor("b", "com.apple.TextEdit")).threadId).toBe("b");
      answer({ ok: true });
      await vi.waitFor(() =>
        expect(
          h.controller.nativeWorkConflicts({ kind: "app", appId: "com.apple.calculator" }),
        ).toBe(false),
      );
    } finally {
      h.controller.close();
    }
  });
  it("keeps a stuck generation excluded and drains it again instead of retiring the helper", async () => {
    const h = make();
    const { ComputerControlError } = await import("@t3tools/shared/computerControl");
    h.request.mockRejectedValueOnce(new ComputerControlError({ _tag: "OutcomeUnknown" }));
    vi.mocked(h.helper.drain!).mockRejectedValueOnce(
      new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" }),
    );
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      await expect(h.controller.invoke(envelope("stuck", a))).rejects.toMatchObject({
        error: { _tag: "OutcomeUnknown" },
      });
      const scope = { kind: "app" as const, appId: "com.apple.calculator" };
      await vi.waitFor(() => expect(h.helper.drain).toHaveBeenCalledTimes(1));
      expect(h.controller.nativeWorkConflicts(scope)).toBe(true);
      await vi.waitFor(() => expect(h.helper.drain).toHaveBeenCalledTimes(2), { timeout: 2000 });
      await vi.waitFor(() => expect(h.controller.nativeWorkConflicts(scope)).toBe(false));
    } finally {
      h.controller.close();
    }
  });
  it("keeps a confirmed action's success when it is cancelled during its screenshot", async () => {
    const h = make();
    h.request.mockImplementationOnce(() => new Promise(() => {}));
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      const pending = h.controller.invoke(envelope("confirmed", a, { screenshot: true }));
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
      h.event({ type: "actionConfirmed", requestId: "confirmed", executionGeneration: 1 });
      h.controller.cancel("confirmed", "p");
      await expect(pending).resolves.toMatchObject({
        actionCompleted: true,
        screenshotError: "Interrupted",
      });
      expect(h.controller.resumeTarget("p", "a").recovery).toBe(false);
    } finally {
      h.controller.close();
    }
  });
  it("drains a thread's native work on invalidation even after its lease was released", async () => {
    const h = make();
    let answer: (value: unknown) => void = () => {};
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    try {
      const a = h.controller.acquire(holderFor("a", "com.apple.calculator"));
      void h.controller.invoke(envelope("inflight", a)).catch(() => undefined);
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
      // The backend releases first, as cancellation and policy transitions do.
      h.lease.release(a);
      let done = false;
      const invalidated = h.controller.invalidateThread("p", "a", 1).then(() => {
        done = true;
      });
      await vi.waitFor(() =>
        expect(h.helper.drain).toHaveBeenCalledWith(a.executionGeneration, 5000),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(done).toBe(false);
      answer({ ok: true });
      await invalidated;
      expect(done).toBe(true);
    } finally {
      h.controller.close();
    }
  });
  it("fails other threads' background mutations fast while a takeover is armed", async () => {
    const h = make();
    try {
      const b = h.controller.acquire(holderFor("b", "com.apple.TextEdit"));
      const reservation = h.lease.reserveTakeover({
        ...holderFor("a", "com.apple.calculator"),
        scope: { kind: "takeover", appId: "com.apple.calculator", approvalReceipt: "pending" },
      });
      const takeover = h.lease.armTakeover(reservation, "receipt");
      expect(h.overlay.show).toHaveBeenCalledWith(takeover);
      await expect(h.controller.invoke(envelope("busy", b))).rejects.toMatchObject({
        error: { _tag: "TargetBlocked", kind: "foreground-busy" },
      });
      // Observations stay available to the background holder.
      await expect(
        h.controller.invoke(
          envelope("look", b, {
            op: "inspect",
            maxNodes: 10,
            snapshotId: undefined,
            elementRef: undefined,
            action: undefined,
          }),
        ),
      ).resolves.toEqual({ ok: true });
      // The takeover only acts on its own app.
      await expect(
        h.controller.invoke(
          envelope("other-app", takeover, {
            delivery: "foreground",
            appId: "com.apple.TextEdit",
          }),
        ),
      ).rejects.toMatchObject({ error: { _tag: "TargetBlocked", kind: "other-app" } });
      expect(h.lease.holders()).toContainEqual(b);
    } finally {
      h.controller.close();
    }
  });
});
