import { it } from "@effect/vitest";
import { Effect, PubSub, Result, Stream } from "effect";
import { describe, expect } from "vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";

import { resolveAuxiliaryTextModel, makeTextGenerationFromRegistry } from "./TextGenerationLive.ts";

const makeStubTextGeneration = (overrides: Partial<TextGenerationShape>): TextGenerationShape => ({
  generateCommitMessage: () =>
    Effect.die("generateCommitMessage stub not configured for this test"),
  generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
  generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
  generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
  generateStructuredJson: () =>
    Effect.die("generateStructuredJson stub not configured for this test"),
  ...overrides,
});

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGenerationShape,
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({ models: [], driver: "codex" }),
    } as unknown as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistryShape => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );
});

describe("auxiliary defaults", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-luna");
  const snapshot = {
    driver: "codex",
    modelCatalog: { status: "complete" },
    models: [{ slug: "gpt-6-luna", isUnlisted: true }, { slug: "gpt-5.6-luna" }],
  } as unknown as import("@t3tools/contracts").ServerProvider;
  it("falls back only for unavailable defaults with reliable discovery", () => {
    expect(resolveAuxiliaryTextModel(selection, snapshot).model).toBe("gpt-5.6-luna");
    for (const status of ["partial", "failed"] as const)
      expect(
        resolveAuxiliaryTextModel(selection, { ...snapshot, modelCatalog: { status } }),
      ).toEqual(selection);
    const explicit = { ...selection, model: "gpt-custom" };
    expect(resolveAuxiliaryTextModel(explicit, snapshot)).toEqual(explicit);
  });
  it("falls back from a version-gated Claude default", () => {
    const claude = {
      ...snapshot,
      driver: "claudeAgent",
      modelCatalog: { status: "menu" },
      models: [{ slug: "claude-haiku-5-5", isUnlisted: true }, { slug: "claude-haiku-4-5" }],
    } as unknown as import("@t3tools/contracts").ServerProvider;
    expect(
      resolveAuxiliaryTextModel({ ...selection, model: "claude-haiku-5-5" }, claude).model,
    ).toBe("claude-haiku-4-5");
  });
});

it.effect("uses merged registry models without waiting on a raw provider probe", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    let usedModel: string | undefined;
    const instance = makeStubInstance(
      instanceId,
      makeStubTextGeneration({
        generateBranchName: (input) => {
          usedModel = input.modelSelection?.model;
          return Effect.succeed({ branch: "branch" });
        },
      }),
    );
    const blocked = { ...instance, snapshot: { ...instance.snapshot, getSnapshot: Effect.never } };
    const snapshot = {
      instanceId,
      driver: "codex",
      modelCatalog: { status: "complete" },
      models: [{ slug: "gpt-6-luna", isUnlisted: true }, { slug: "gpt-5.6-luna" }],
    } as unknown as import("@t3tools/contracts").ServerProvider;
    const textGeneration = makeTextGenerationFromRegistry(
      makeStubRegistry([blocked]),
      Effect.succeed([snapshot]),
    );
    yield* textGeneration.generateBranchName({
      cwd: process.cwd(),
      message: "test",
      modelSelection: createModelSelection(instanceId, "gpt-6-luna"),
    });
    expect(usedModel).toBe("gpt-5.6-luna");
  }),
);
