import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnRegisteredProcess } from "../provider/registeredIntegrationProcess";
import {
  IntegrationProxySession,
  toolInventorySha256,
  type IntegrationProxyDeps,
} from "./IntegrationProxyCatalog";

const FIXTURE = fileURLToPath(new URL("./fixtures/integration-server.mjs", import.meta.url));
const schema = { type: "object", properties: { code: { type: "string" } } };
const inventory = (names: string[]) =>
  toolInventorySha256(names.map((name) => ({ name, inputSchema: schema })));

const sessions: IntegrationProxySession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

function setup(patch: Partial<IntegrationProxyDeps> & { env?: NodeJS.ProcessEnv } = {}) {
  // Mirrors main: acquisition is idempotent per holder, release clears it.
  const state = {
    policy: true,
    paused: false,
    generation: "g1" as string | undefined,
    held: false,
  };
  const acquireLease = vi.fn(async () => {
    state.held = true;
  });
  const releaseLease = vi.fn(() => {
    state.held = false;
  });
  const consent = vi.fn(async () => true);
  const exited = vi.fn();
  const spawn = vi.fn(spawnRegisteredProcess);
  const session = new IntegrationProxySession({
    integration: "codex-chrome",
    threadId: "t",
    generation: "g1",
    command: process.execPath,
    args: [FIXTURE],
    env: {
      PATH: process.env.PATH ?? "",
      FIXTURE_TOOLS: '["js","js_reset","extra"]',
      ...patch.env,
    },
    allowedTools: ["js", "js_reset"],
    toolInventorySha256: inventory(["js", "js_reset", "extra"]),
    advertisedTools: [
      { name: "js", inputSchema: schema },
      { name: "js_reset", inputSchema: schema },
    ],
    identity: {
      profileId: "p",
      backendIncarnation: "i",
      threadId: "t",
      sessionGeneration: "g1",
      integration: "codex-chrome",
    },
    register: async () => {},
    exited,
    policyEnabled: async () => state.policy,
    currentGeneration: () => state.generation,
    paused: () => state.paused,
    consent,
    acquireLease,
    releaseLease,
    spawn,
    drainKillMs: 200,
    teardownKillMs: 200,
    ...patch,
  });
  sessions.push(session);
  return { session, state, acquireLease, releaseLease, consent, exited, spawn };
}
const text = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

describe("integration proxy", () => {
  it("lists the record's tools without starting the child, then verifies a paged, reordered inventory", async () => {
    const { session, spawn, consent } = setup({
      env: { FIXTURE_REVERSE: "1", FIXTURE_PAGE_SIZE: "2" },
    });
    expect((await session.listTools()).map((tool) => tool.name)).toEqual(["js", "js_reset"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(consent).not.toHaveBeenCalled();
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("never spawns when the user declines consent", async () => {
    const { session, spawn } = setup({ consent: async () => false });
    expect(text(await session.callTool("js", { code: "a" }))).toContain("didn't allow");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("denies every call until the inventory matches the record", async () => {
    const { session, acquireLease } = setup({ toolInventorySha256: inventory(["js"]) });
    const result = await session.callTool("js", { code: "1" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("tools changed");
    expect(acquireLease).not.toHaveBeenCalled();
    const uncertified = setup({ toolInventorySha256: undefined });
    expect((await uncertified.session.callTool("js", { code: "1" })).isError).toBe(true);
    const misadvertised = setup({
      advertisedTools: [{ name: "js", inputSchema: { type: "object" } }],
    });
    expect(text(await misadvertised.session.callTool("js", { code: "1" }))).toContain(
      "tools changed",
    );
  });

  it("forwards an admitted call under the lease and asks consent once", async () => {
    const { session, state, releaseLease, consent } = setup();
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    expect(text(await session.callTool("js", { code: "b" }))).toBe("ran b");
    expect(consent).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(2);
    expect(state.held).toBe(false);
    expect(text(await session.callTool("extra", {}))).toContain("isn't allowed");
  });

  it("checks live policy, pause and generation on every call", async () => {
    const { session, state, acquireLease } = setup();
    state.policy = false;
    expect(text(await session.callTool("js", { code: "a" }))).toContain("turned off");
    state.policy = true;
    state.paused = true;
    expect(text(await session.callTool("js", { code: "a" }))).toContain("paused");
    state.paused = false;
    state.generation = "g2";
    expect(text(await session.callTool("js", { code: "a" }))).toContain("unavailable");
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("rechecks policy after the lease wait and never forwards a revoked call", async () => {
    const { session, state } = setup({
      acquireLease: async () => {
        state.held = true;
        // The user turns the integration off while ownership is being taken.
        state.policy = false;
      },
    });
    const result = await session.callTool("js", { code: "a" });
    expect(text(result)).toContain("turned off");
    expect(state.held).toBe(false);
    expect(session.inFlight).toEqual([]);
  });

  it("re-verifies after tools/list_changed and then denies a changed inventory", async () => {
    const { session } = setup();
    expect(text(await session.callTool("js", { code: "change" }))).toBe("ran change");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(text(await session.callTool("js", { code: "a" }))).toContain("tools changed");
  });

  it("drops a late response after the generation changes and releases its lease", async () => {
    const { session, state } = setup();
    const pending = session.callTool("js", { code: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    state.generation = "g2";
    expect(text(await pending)).toContain("discarded");
    expect(state.held).toBe(false);
  });

  it("cancels on pause, keeps the lease while draining, kills a hung child and then releases", async () => {
    const { session, state, exited } = setup();
    expect(text(await session.callTool("js", { code: "warm" }))).toBe("ran warm");
    const pending = session.callTool("js", { code: "hang" });
    await vi.waitFor(() =>
      expect(session.inFlight).toEqual([expect.objectContaining({ state: "forwarded" })]),
    );
    session.cancel();
    expect(session.inFlight[0]?.state).toBe("cancelled");
    expect(state.held).toBe(true);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(state.held).toBe(false);
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
  });

  it("cancels the one call a client names and stops a call past its deadline", async () => {
    const { session, state } = setup({ callTimeoutMs: 300 });
    expect(text(await session.callTool("js", { code: "warm" }, "warm"))).toBe("ran warm");
    const named = session.callTool("js", { code: "hang" }, "c1");
    await vi.waitFor(() => expect(session.inFlight).toHaveLength(1));
    session.cancelCall("c1");
    expect(session.inFlight[0]?.state).toBe("cancelled");
    expect((await named).isError).toBe(true);
    await vi.waitFor(() => expect(state.held).toBe(false));

    const late = await session.callTool("js", { code: "hang" }, "c2");
    expect(text(late)).toContain("took too long");
    // The lease outlives the deadline until the drained child exits.
    await vi.waitFor(() => expect(state.held).toBe(false));
  });

  it("keeps the shared lease until the last parallel call settles", async () => {
    const { session, state, releaseLease } = setup();
    const slow = session.callTool("js", { code: "slow" }, "slow");
    await vi.waitFor(() =>
      expect(session.inFlight).toEqual([expect.objectContaining({ state: "forwarded" })]),
    );
    expect(text(await session.callTool("js", { code: "fast" }, "fast"))).toBe("ran fast");
    // The fast call settled while the slow one is still forwarded: ownership stays.
    expect(state.held).toBe(true);
    expect(releaseLease).not.toHaveBeenCalled();
    expect(text(await slow)).toBe("ran slow");
    expect(state.held).toBe(false);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    const results = await Promise.all(
      ["a", "b", "c"].map((code) => session.callTool("js", { code }, `call-${code}`)),
    );
    expect(results.map(text)).toEqual(["ran a", "ran b", "ran c"]);
    expect(state.held).toBe(false);
  });

  it("answers server-initiated requests instead of leaving the child waiting", async () => {
    const { session } = setup();
    expect(text(await session.callTool("js", { code: "ask" }))).toBe("answered -32601");
  });

  it("tears the child down on dispose and refuses further calls", async () => {
    const { session, exited } = setup();
    await session.callTool("js", { code: "a" });
    await session.dispose();
    expect(exited).toHaveBeenCalledTimes(1);
    expect(text(await session.callTool("js", { code: "a" }))).toContain("ended");
    expect(await session.listTools()).toEqual([]);
  });
});
