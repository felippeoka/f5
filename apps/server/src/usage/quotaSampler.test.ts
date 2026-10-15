import { assert, it } from "@effect/vitest";
import type { AccountUsageSection, UsageAccount } from "@t3tools/contracts";
import { Effect, Exit, Fiber, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { AccountUsageCapability } from "./accountUsage.ts";
import type { AccountHistoryRecorder } from "./accountHistory.ts";
import { emptyAccountSection, makeAccountUsageCapability } from "./Layers/AccountUsageService.ts";
import { makeQuotaSampler, quotaSamplerBackoffMinutes } from "./quotaSampler.ts";

const available = (fetchedAt = "2026-10-15T10:00:00.000Z"): AccountUsageSection => ({
  kind: "provider-limits",
  outcome: "available",
  lastAttemptAt: fetchedAt,
  errorCode: null,
  snapshot: { fetchedAt, data: { windows: [] } },
});
const failed: AccountUsageSection = {
  ...emptyAccountSection("provider-limits"),
  errorCode: "temporary-failure",
  lastAttemptAt: "2026-10-15T10:00:00.000Z",
};

const account = (key: string, sections: ReadonlyArray<AccountUsageSection>): UsageAccount => ({
  key,
  provider: "cursor",
  providerInstanceId: null,
  displayName: key,
  enabled: true,
  refreshState: "idle",
  sections,
});

interface FakeCapability {
  readonly capability: AccountUsageCapability;
  readonly calls: Array<string>;
}

function fakeCapability(
  key: string,
  probe: (call: number) => Effect.Effect<ReadonlyArray<AccountUsageSection>>,
  state: Partial<UsageAccount> = {},
): FakeCapability {
  const calls: Array<string> = [];
  let current = { ...account(key, [emptyAccountSection("provider-limits")]), ...state };
  return {
    calls,
    capability: {
      identity: `id:${key}`,
      getSnapshot: Effect.sync(() => current),
      refresh: () => Effect.void,
      refreshAccount: (_permits, mode) =>
        Effect.gen(function* () {
          calls.push(mode ?? "force");
          const sections = yield* probe(calls.length);
          current = { ...current, sections };
          return { snapshot: current, fresh: true };
        }),
    },
  };
}

const instance = (
  capability: AccountUsageCapability | undefined,
  enabled = true,
): ProviderInstance =>
  ({ instanceId: "test", enabled, accountUsage: capability }) as unknown as ProviderInstance;

function harness(instances: ReadonlyArray<ProviderInstance>) {
  const observed: Array<string> = [];
  const pruned: Array<ReadonlyArray<string>> = [];
  const recorder: AccountHistoryRecorder = {
    observe: (snapshot) => Effect.sync(() => void observed.push(snapshot.key)),
    hydrate: (snapshot) => snapshot,
  };
  return Effect.gen(function* () {
    const sampler = makeQuotaSampler({
      listInstances: Effect.succeed(instances),
      listAccountKeys: Effect.succeed(["keep"]),
      permits: yield* Semaphore.make(2),
      recorder,
      prune: (input) => Effect.sync(() => void pruned.push(input.keepAccountKeys)),
    });
    return { sampler, observed, pruned };
  });
}

it("spaces backoff at 10, 20, 40 minutes capped at two hours", () => {
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5, 10].map(quotaSamplerBackoffMinutes),
    [0, 10, 20, 40, 80, 120, 120],
  );
});

it.effect("skips disabled, unsupported, busy, and refresh-less accounts", () =>
  Effect.gen(function* () {
    const disabled = fakeCapability("disabled", () => Effect.succeed([available()]));
    const unsupported = fakeCapability("unsupported", () => Effect.succeed([available()]), {
      sections: [
        { ...emptyAccountSection("provider-limits"), errorCode: "unsupported" },
        { ...emptyAccountSection("provider-limits"), errorCode: "authentication-required" },
      ],
    });
    const busy = fakeCapability("busy", () => Effect.succeed([available()]), {
      refreshState: "queued",
    });
    const healthy = fakeCapability("healthy", () => Effect.succeed([available()]));
    const { refreshAccount: _omit, ...withoutRefresh } = healthy.capability;
    const { sampler, observed, pruned } = yield* harness([
      instance(disabled.capability, false),
      instance(unsupported.capability),
      instance(busy.capability),
      instance(withoutRefresh as AccountUsageCapability),
      instance(undefined),
      instance(healthy.capability),
    ]);
    yield* sampler.tick;
    assert.deepStrictEqual(
      [disabled, unsupported, busy].map((entry) => entry.calls.length),
      [0, 0, 0],
    );
    assert.deepStrictEqual(healthy.calls, ["if-stale"]);
    assert.deepStrictEqual(observed, ["healthy"]);
    assert.deepStrictEqual(pruned, [["keep"]]);
  }),
);

it.effect("respects the capability if-stale TTL", () =>
  Effect.gen(function* () {
    let reads = 0;
    const capability = yield* makeAccountUsageCapability(
      account("ttl", [emptyAccountSection("provider-limits")]),
      Effect.sync(() => {
        reads++;
        return [available()];
      }),
      { identity: "id:ttl" },
    );
    const { sampler } = yield* harness([instance(capability)]);
    yield* sampler.tick;
    yield* TestClock.adjust("1 minute");
    yield* sampler.tick;
    assert.equal(reads, 1);
    yield* TestClock.adjust("5 minutes");
    yield* sampler.tick;
    assert.equal(reads, 2);
  }),
);

it.effect("backs off failing accounts and resets after partial success", () =>
  Effect.gen(function* () {
    const succeedOn = 4;
    const fake = fakeCapability("flaky", (call) =>
      Effect.succeed(call >= succeedOn ? [failed, available()] : [failed]),
    );
    const { sampler } = yield* harness([instance(fake.capability)]);
    const probesAt: Array<number> = [];
    for (let minute = 0; minute <= 80; minute += 10) {
      const before = fake.calls.length;
      yield* sampler.tick;
      if (fake.calls.length > before) probesAt.push(minute);
      yield* TestClock.adjust("10 minutes");
    }
    // Failures at 0, 10, 30; the 70-minute probe partially succeeds and resets.
    assert.deepStrictEqual(probesAt, [0, 10, 30, 70, 80]);
  }),
);

it.effect("isolates a per-instance defect and releases a hung probe", () =>
  Effect.gen(function* () {
    const broken = fakeCapability("broken", () => Effect.die("boom"));
    const hung = fakeCapability("hung", () => Effect.never);
    const healthy = fakeCapability("healthy", () => Effect.succeed([available()]));
    const { sampler, observed } = yield* harness([
      instance(broken.capability),
      instance(hung.capability),
      instance(healthy.capability),
    ]);
    const fiber = yield* Effect.forkChild(sampler.tick);
    yield* TestClock.adjust("2 minutes");
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(healthy.calls, ["if-stale"]);
    assert.deepStrictEqual(observed, ["healthy"]);
  }),
);

it.effect("starts after one minute, repeats every ten, and stops with its scope", () =>
  Effect.gen(function* () {
    const fake = fakeCapability("loop", () => Effect.succeed([available()]));
    const { sampler } = yield* harness([instance(fake.capability)]);
    const scope = yield* Scope.make();
    yield* sampler.run.pipe(Effect.forkIn(scope));
    yield* TestClock.adjust("59 seconds");
    assert.equal(fake.calls.length, 0);
    yield* TestClock.adjust("1 second");
    assert.equal(fake.calls.length, 1);
    yield* TestClock.adjust("10 minutes");
    assert.equal(fake.calls.length, 2);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("1 hour");
    assert.equal(fake.calls.length, 2);
  }),
);
