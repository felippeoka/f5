import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder, DesktopComputerHostMessage } from "@t3tools/contracts";
import {
  ComputerAutomationBrokerRuntime,
  type ComputerInvocationContext,
} from "./ComputerAutomationBroker";
import { DesktopComputerHost } from "./DesktopComputerHost";

class Ipc extends EventEmitter {
  connected = true;
  messages: DesktopComputerHostMessage[] = [];
  holdRequests = false;
  appResults: unknown[] | undefined;
  busy = false;
  send(raw: unknown, callback: (error: Error | null) => void) {
    const message = raw as DesktopComputerHostMessage;
    this.messages.push(message);
    callback(null);
    if (message.type === "hello")
      queueMicrotask(() => this.emit("message", { type: "status", status: { available: true } }));
    if (message.type === "leaseAcquire")
      queueMicrotask(() =>
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ...(this.busy
            ? { error: { _tag: "Busy", holder: "other-profile" } }
            : {
                result: { ...message.holder, executionGeneration: 7 } satisfies ComputerLeaseHolder,
              }),
        }),
      );
    if (message.type === "observationInvalidate")
      queueMicrotask(() =>
        this.emit("message", { type: "response", requestId: message.requestId, result: {} }),
      );
    if (message.type === "request" && !this.holdRequests)
      queueMicrotask(() =>
        this.emit("message", {
          type: "response",
          requestId: message.request.requestId,
          result:
            message.request.op === "resolveApps" && this.appResults
              ? this.appResults
              : { ok: true },
        }),
      );
    return true;
  }
  finish() {
    const request = this.messages.findLast((message) => message.type === "request");
    if (request?.type === "request")
      this.emit("message", {
        type: "response",
        requestId: request.request.requestId,
        result: { ok: true },
      });
  }
}
async function harness() {
  const ipc = new Ipc();
  const host = new DesktopComputerHost("p", "backend", ipc, true);
  let context: ComputerInvocationContext = {
    threadId: "t",
    sessionGeneration: "s",
    projectId: "project",
    turnId: "turn",
    provider: "claude",
    runtimeMode: "full-access",
    interactionMode: "default",
    threadTitle: "Thread",
    policy: {
      previewAutomation: true,
      externalHosts: [],
      computerUse: true,
      claudeInChrome: false,
    },
  };
  const broker = new ComputerAutomationBrokerRuntime(host, {
    resolve: async (_thread, generation) => ({ ...context, sessionGeneration: generation }),
    platform: "darwin",
    storage: {
      load: async () => [
        { projectId: "project", appId: "com.apple.TextEdit", tier: "full", allowTyping: false },
      ],
      save: async () => {},
    },
  });
  await broker.initialize();
  broker.bindSession("t", "s", "claude");
  await Promise.resolve();
  return {
    broker,
    ipc,
    set: (patch: Partial<ComputerInvocationContext>) => {
      context = { ...context, ...patch };
    },
  };
}
describe("computer broker safety boundaries", () => {
  it("reports full-tier typing rights without changing the stored click-tier flag", async () => {
    const h = await harness();
    h.ipc.appResults = [
      {
        appId: "com.apple.TextEdit",
        name: "TextEdit",
        tier: "full",
        running: true,
        frontmost: false,
      },
    ];
    try {
      const result = await h.broker.requestAccess(
        "t",
        "s",
        ["com.apple.TextEdit"],
        "Synthetic typing test",
        true,
      );
      expect(result).toMatchObject({
        grants: [
          { appId: "com.apple.TextEdit", tier: "full", allowTyping: false, typingAllowed: true },
        ],
        apps: [{ status: "already-granted" }],
      });
      expect(h.broker.access.grants("t")).toEqual([
        { appId: "com.apple.TextEdit", tier: "full", allowTyping: false },
      ]);
      expect(h.ipc.messages.some((message) => message.type === "accessRequested")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("publishes tool-boundary outcome codes only for the matching session", async () => {
    const h = await harness();
    const events = vi.fn();
    h.broker.subscribe(events);
    try {
      h.broker.reportToolFailure("t", "old-session", "elementAction", "app-resolution-failed");
      expect(events).not.toHaveBeenCalled();
      h.broker.reportToolFailure("t", "s", "elementAction", "app-resolution-failed");
      expect(events).toHaveBeenCalledExactlyOnceWith({
        channel: "computer.activity",
        data: {
          threadId: "t",
          backend: "native",
          op: "elementAction",
          status: "failed",
          outcome: "app-resolution-failed",
        },
      });
    } finally {
      h.broker.close();
    }
  });
  it("allows remote preview resume when computer tools were installed but never used", async () => {
    const h = await harness();
    try {
      h.broker.setPaused("t", true);
      h.ipc.emit("message", {
        type: "status",
        status: { available: false, reason: "helper-missing" },
      });
      expect(() => h.broker.assertRemoteResumeAllowed("t")).not.toThrow();
      expect(() => h.broker.setPaused("t", false)).not.toThrow();
    } finally {
      h.broker.close();
    }
  });
  it("returns turn-ended when a session is released during context resolution", async () => {
    const h = await harness();
    try {
      const pending = h.broker.invoke("t", "s", { op: "listApps" });
      h.broker.releaseSession("t", "s");
      await expect(pending).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "turn-ended" },
      });
      expect(h.broker.access.grants("t")).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("keeps native pause authoritative and refuses remote resume", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", { type: "pauseChanged", threadId: "t", paused: true });
      expect(() => h.broker.assertRemoteResumeAllowed("t")).toThrow("computer running F5");
      expect(() => h.broker.setPaused("t", false)).toThrow("computer running F5");
      expect(h.broker.pause.has("t")).toBe(true);
      expect(h.ipc.messages.some((message) => message.type === "resumeRequested")).toBe(false);
      h.ipc.emit("message", { type: "pauseChanged", threadId: "t", paused: false });
      expect(h.broker.pause.has("t")).toBe(false);
      expect(() => h.broker.assertRemoteResumeAllowed("preview-only")).not.toThrow();
    } finally {
      h.broker.close();
    }
  });
  it("rejects keyboard mutation before acquiring a lease when no grant permits typing", async () => {
    const h = await harness();
    try {
      await h.broker.invoke("t", "s", { op: "listApps" });
      h.broker.access.revoke("t", "com.apple.TextEdit");
      for (const input of [
        { op: "type" as const, text: "x" },
        { op: "key" as const, chords: ["ENTER"] },
      ])
        await expect(h.broker.invoke("t", "s", input)).rejects.toMatchObject({
          error: { _tag: "NotGranted", needed: "type" },
        });
      expect(h.ipc.messages.some((message) => message.type === "leaseAcquire")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("does not prompt for ambiguous app matches or grant every fuzzy match", async () => {
    const h = await harness();
    try {
      h.ipc.appResults = [
        { appId: "code", name: "Code", tier: "click", running: true, frontmost: false },
        { appId: "xcode", name: "Xcode", tier: "click", running: true, frontmost: false },
      ];
      const result = await h.broker.requestAccess("t", "s", ["co"], "Edit code");
      expect(result).toMatchObject({
        apps: [
          { query: "co", status: "ambiguous", matches: [{ appId: "code" }, { appId: "xcode" }] },
        ],
      });
      expect(h.ipc.messages.some((message) => message.type === "accessRequested")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("keeps Chrome consent separate from computer grants and rechecks its own policy", async () => {
    const h = await harness();
    try {
      h.set({
        policy: {
          previewAutomation: true,
          externalHosts: [],
          computerUse: false,
          claudeInChrome: true,
        },
      });
      const consent = h.broker.requestChromeSetup("t", "s", {
        provider: "claude",
        previousTargets: ["old"],
        targetPath: "new",
      });
      const request = h.ipc.messages.findLast((m) => m.type === "accessRequested");
      if (request?.type !== "accessRequested") throw new Error("missing setup request");
      await h.broker.refreshPolicies();
      h.ipc.emit("message", {
        type: "accessAnswer",
        answer: {
          requestId: request.request.requestId,
          backendIncarnation: "old",
          decisions: [],
          allowChromeSetup: true,
        },
      });
      expect(
        h.ipc.messages.some(
          (m) => m.type === "cancel" && m.requestId === request.request.requestId,
        ),
      ).toBe(false);
      h.ipc.emit("message", {
        type: "accessAnswer",
        answer: {
          requestId: request.request.requestId,
          backendIncarnation: "backend",
          decisions: [],
          allowChromeSetup: true,
          allowSessionActions: true,
        },
      });
      expect(await consent).toBe(true);
      expect(h.broker.access.actionsApproved("t")).toBe(false);
      const next = h.broker.requestChromeSetup("t", "s", {
        provider: "claude",
        previousTargets: [],
        targetPath: "new",
      });
      h.set({
        policy: {
          previewAutomation: true,
          externalHosts: [],
          computerUse: false,
          claudeInChrome: false,
        },
      });
      await h.broker.refreshPolicies();
      expect(await next).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("disposing native tools leaves the Chrome lease to the provider exit finalizer", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", {
        type: "chromeLeaseChanged",
        holder: { profileId: "p", threadId: "t", sessionGeneration: "s", provider: "claude" },
      });
      h.broker.releaseSession("t", "s");
      expect(h.ipc.messages.some((message) => message.type === "chromeLeaseRelease")).toBe(false);
      expect(h.broker.snapshot().chromeHolder?.threadId).toBe("t");
    } finally {
      h.broker.close();
    }
  });
  it("restores anonymous contention and paused controls in a reconnect snapshot", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", { type: "leaseChanged", holder: null, otherProfile: true });
      h.broker.setPaused("t", true);
      expect(h.broker.snapshot()).toMatchObject({
        holders: [],
        computerUse: { holders: [], otherProfile: true },
        otherProfile: true,
        pausedThreads: ["t"],
      });
    } finally {
      h.broker.close();
    }
  });
  it("ignores a kill notification for an older session or completed turn", async () => {
    const h = await harness();
    const events: unknown[] = [];
    const off = h.broker.subscribe((event) => events.push(event));
    try {
      await h.broker.invoke("t", "s", { op: "type", text: "x" });
      h.ipc.emit("message", {
        type: "killSwitch",
        threadId: "t",
        sessionGeneration: "old",
        turnId: "turn",
      });
      expect(events).toEqual([]);
      h.broker.endTurn("t", "turn", "s");
      h.ipc.emit("message", {
        type: "killSwitch",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
      });
      expect(events).toEqual([]);
    } finally {
      off();
      h.broker.close();
    }
  });
  it("rechecks live policy, plan mode and pause before acquiring the device", async () => {
    const h = await harness();
    try {
      h.set({ interactionMode: "plan" });
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toThrow(
        "plan mode",
      );
      await expect(h.broker.invoke("t", "s", { op: "listApps" })).resolves.toEqual({ ok: true });
      h.set({ interactionMode: "default" });
      h.broker.setPaused("t", true);
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Interrupted" },
      });
      expect(h.ipc.messages.filter((m) => m.type === "leaseAcquire")).toHaveLength(0);
    } finally {
      h.broker.close();
    }
  });
  it("reports cross-profile contention without sending input", async () => {
    const h = await harness();
    try {
      h.ipc.busy = true;
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Busy", holder: "other-profile" },
      });
      expect(h.ipc.messages.some((m) => m.type === "request")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("turn completion cancels before release, retains grants and rejects a late invocation", async () => {
    const h = await harness();
    try {
      await h.broker.invoke("t", "s", { op: "type", text: "x" });
      h.broker.endTurn("t", "old", "s");
      expect(h.ipc.messages.some((m) => m.type === "leaseRelease")).toBe(false);
      h.broker.endTurn("t", "turn", "s");
      expect(h.ipc.messages.some((m) => m.type === "leaseRelease")).toBe(true);
      expect(h.broker.access.grants("t")).toHaveLength(1);
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "turn-ended" },
      });
      h.broker.bindSession("t", "new", "codex");
      h.broker.releaseSession("t", "s");
      expect(h.broker.generation("t")).toBe("new");
    } finally {
      h.broker.close();
    }
  });
  it("a queued semantic action revalidates a revoked app grant", async () => {
    const h = await harness();
    try {
      h.ipc.holdRequests = true;
      const first = h.broker.invoke("t", "s", { op: "type", text: "x" });
      await vi.waitFor(() => expect(h.ipc.messages.some((m) => m.type === "request")).toBe(true));
      const second = h.broker.invoke("t", "s", {
        op: "elementAction",
        appId: "com.apple.TextEdit",
        snapshotId: "snapshot",
        elementRef: "element",
        action: "press",
      });
      h.broker.access.revoke("t", "com.apple.TextEdit");
      h.ipc.finish();
      await first;
      await expect(second).rejects.toMatchObject({ error: { _tag: "NotGranted" } });
      expect(h.ipc.messages.filter((m) => m.type === "request")).toHaveLength(1);
    } finally {
      h.broker.close();
    }
  });
});

describe("background delivery", () => {
  async function backgroundHarness() {
    const h = await harness();
    h.set({
      policy: {
        previewAutomation: true,
        externalHosts: [],
        computerUse: true,
        claudeInChrome: false,
        computerUseExecutionMode: "background",
      },
    });
    h.ipc.emit("message", { type: "hostCapabilities", capabilities: ["background-ax-v1"] });
    h.ipc.emit("message", {
      type: "status",
      status: { available: true, background: { available: true } },
    });
    return h;
  }
  async function approveBackgroundSession(h: Awaited<ReturnType<typeof harness>>) {
    await vi.waitFor(() =>
      expect(h.ipc.messages.some((m) => m.type === "accessRequested")).toBe(true),
    );
    const request = h.ipc.messages.findLast((m) => m.type === "accessRequested");
    if (request?.type !== "accessRequested") throw new Error("missing session request");
    expect(request.request).toMatchObject({ kind: "session-actions", background: true });
    h.ipc.emit("message", {
      type: "accessAnswer",
      answer: {
        requestId: request.request.requestId,
        backendIncarnation: "backend",
        decisions: [],
        allowSessionActions: true,
        sessionReceipt: "receipt",
      },
    });
  }
  it("stays foreground until the policy prefers background and every peer negotiated it", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", {
        type: "status",
        status: { available: true, background: { available: true } },
      });
      await expect(h.broker.classify("t", "s", "type", "com.apple.TextEdit", {})).resolves.toBe(
        "foreground",
      );
      h.set({
        policy: {
          previewAutomation: true,
          externalHosts: [],
          computerUse: true,
          claudeInChrome: false,
          computerUseExecutionMode: "background",
        },
      });
      // No hostCapabilities answer: the desktop is a legacy peer.
      await expect(
        h.broker.classify("t", "s", "type", "com.apple.TextEdit", {}),
      ).rejects.toMatchObject({ error: { _tag: "Execution" } });
      h.ipc.emit("message", { type: "hostCapabilities", capabilities: ["background-ax-v1"] });
      await expect(h.broker.classify("t", "s", "type", "com.apple.TextEdit", {})).resolves.toBe(
        "background",
      );
    } finally {
      h.broker.close();
    }
  });
  it("needs a native session approval, then acquires an app-scoped lease", async () => {
    const h = await backgroundHarness();
    try {
      const typed = h.broker.invoke("t", "s", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      const acquire = h.ipc.messages.find((m) => m.type === "leaseAcquire");
      expect(acquire).toMatchObject({
        holder: {
          scope: { kind: "app", appId: "com.apple.TextEdit" },
          policyRevision: expect.any(Number),
        },
      });
      const request = h.ipc.messages.findLast((m) => m.type === "request");
      expect(request).toMatchObject({
        request: { op: "type", appId: "com.apple.TextEdit", delivery: "background" },
      });
      expect(request?.type === "request" && "executionMode" in request.request).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("requires an app and refuses coordinate input in background", async () => {
    const h = await backgroundHarness();
    try {
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Execution", message: "Specify app: the app to act in." },
      });
      await expect(
        h.broker.invoke("t", "s", { op: "click", x: 1, y: 1, appId: "com.apple.TextEdit" }),
      ).rejects.toMatchObject({
        error: { _tag: "ForegroundRequired", reason: "unsupported-in-background" },
      });
      await expect(
        h.broker.invoke("t", "s", {
          op: "elementAction",
          appId: "com.apple.TextEdit",
          snapshotId: "snapshot",
          elementRef: "element",
          action: "press",
          executionMode: "foreground",
        }),
      ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
      expect(h.ipc.messages.filter((m) => m.type === "leaseAcquire")).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("drops a released holder's active state but keeps paused and recovery states", async () => {
    const h = await backgroundHarness();
    try {
      const holder = {
        profileId: "p",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
        executionGeneration: 3,
        grantVersion: 1,
        grants: [],
        backend: "native",
        threadTitle: "Thread",
        scope: { kind: "app", appId: "com.apple.TextEdit" },
        policyRevision: 1,
      };
      h.ipc.emit("message", { type: "leasesChanged", holders: [holder], otherProfile: false });
      h.ipc.emit("message", {
        type: "executionStateChanged",
        threadId: "t",
        sessionGeneration: "s",
        state: "active",
        delivery: "background",
        appId: "com.apple.TextEdit",
      });
      expect(h.broker.computerUse().holders).toMatchObject([{ threadId: "t", state: "active" }]);
      h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: false });
      expect(h.broker.computerUse().holders).toEqual([]);
      h.ipc.emit("message", {
        type: "executionStateChanged",
        threadId: "t",
        sessionGeneration: "s",
        state: "recovery",
        pauseCause: "outcome-unknown",
      });
      h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: false });
      expect(h.broker.computerUse().holders).toMatchObject([
        { threadId: "t", state: "recovery", pauseCause: "outcome-unknown" },
      ]);
      h.broker.releaseSession("t", "s");
      expect(h.broker.computerUse().holders).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("arms a natively approved takeover and refuses a declined one", async () => {
    const h = await backgroundHarness();
    h.ipc.appResults = [
      {
        appId: "com.apple.TextEdit",
        name: "TextEdit",
        tier: "full",
        running: true,
        frontmost: false,
      },
    ];
    try {
      const typed = h.broker.invoke("t", "s", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      const answerTakeover = async (allow: boolean) => {
        await vi.waitFor(() =>
          expect(
            h.ipc.messages.some(
              (m) => m.type === "accessRequested" && m.request.kind === "foreground-takeover",
            ),
          ).toBe(true),
        );
        const request = h.ipc.messages.findLast(
          (m) => m.type === "accessRequested" && m.request.kind === "foreground-takeover",
        );
        const acquire = h.ipc.messages.findLast((m) => m.type === "foregroundTakeoverAcquire");
        if (request?.type !== "accessRequested" || acquire?.type !== "foregroundTakeoverAcquire")
          throw new Error("missing takeover exchange");
        expect(acquire.approvalRequestId).toBe(request.request.requestId);
        expect(request.request.takeover).toMatchObject({
          appId: "com.apple.TextEdit",
          threadId: "t",
          turnId: "turn",
        });
        h.ipc.messages.length = 0;
        h.ipc.emit("message", {
          type: "accessAnswer",
          answer: {
            requestId: request.request.requestId,
            backendIncarnation: "backend",
            decisions: [],
            allowForegroundTakeover: allow,
          },
        });
        if (allow)
          h.ipc.emit("message", {
            type: "response",
            requestId: acquire.requestId,
            result: { ...acquire.holder, executionGeneration: 9 },
          });
        return acquire.requestId;
      };
      const declined = h.broker.requestForeground("t", "s", "TextEdit", "Needs a drag");
      const declinedId = await answerTakeover(false);
      await expect(declined).rejects.toMatchObject({ error: { _tag: "NotGranted" } });
      expect(h.ipc.messages).toContainEqual({ type: "cancel", requestId: declinedId });
      const approved = h.broker.requestForeground("t", "s", "TextEdit", "Needs a drag");
      await answerTakeover(true);
      await expect(approved).resolves.toMatchObject({
        foreground: true,
        appId: "com.apple.TextEdit",
      });
      expect(h.broker.computerUse().holders).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("closes admissions and bumps the revision during a policy transition", async () => {
    const h = await backgroundHarness();
    try {
      const typed = h.broker.invoke("t", "s", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      let applied = false;
      const transition = h.broker.policyTransition(async () => {
        applied = true;
        h.set({
          policy: {
            previewAutomation: true,
            externalHosts: [],
            computerUse: true,
            claudeInChrome: false,
            computerUseExecutionMode: "foreground",
          },
        });
      });
      // Admitted only after the change applies; it then runs under the new mode.
      const queued = h.broker.classify("t", "s", "type", "com.apple.TextEdit", {});
      await transition;
      expect(applied).toBe(true);
      await expect(queued).resolves.toBe("foreground");
      // The session approval for background was revoked with the policy change.
      expect(h.broker.access.backgroundApproved("t")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
});

it("refuses screenshots, zoom and inspection while paused", async () => {
  const h = await harness();
  try {
    h.broker.setPaused("t", true);
    for (const op of ["screenshot", "zoom", "inspect"] as const)
      await expect(h.broker.invoke("t", "s", { op })).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "paused" },
      });
    expect(h.ipc.messages.filter((message) => message.type === "request")).toEqual([]);
  } finally {
    h.broker.close();
  }
});
