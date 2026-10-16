/**
 * TextGenerationLive — registry-backed implementation of the `TextGeneration`
 * service tag.
 *
 * The `TextGeneration` tag is kept as a thin facade over
 * `ProviderInstanceRegistry`. Every op pulls `modelSelection.instanceId`,
 * looks up the matching `ProviderInstance`, and delegates to that instance's
 * own `textGeneration` closure (built by its driver's `create()`).
 *
 * There is deliberately no per-driver dispatch here — the registry already
 * knows which driver backs each instance, and each `ProviderInstance`
 * carries the fully-bound `TextGenerationShape` produced by its driver.
 * That means:
 *
 *   - Multiple instances of the same driver (e.g. `codex_personal`,
 *     `codex_work`) each get their own text-generation closure bound to
 *     their own settings — the routing is by instance, not by driver.
 *   - Unknown or disabled instances surface a `TextGenerationError` with
 *     the missing `instanceId`, instead of silently falling back to a
 *     default.
 *
 * This replaces the old `RoutingTextGenerationLive`, which tried to route
 * by driver-kind and misused `modelSelection.instanceId` as a driver-id
 * literal.
 *
 * @module git/Layers/TextGenerationLive
 */
import { Effect, Layer } from "effect";

import { readRepositoryWritingContext } from "../repositoryInstructions.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateStructuredJson";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

const resolveInstanceSelection = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  selection: ModelSelection,
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>,
) =>
  resolveInstance(registry, operation, selection.instanceId).pipe(
    Effect.flatMap((instance) =>
      getProviders.pipe(
        Effect.map((providers) => {
          const snapshot = providers.find(
            (provider) => provider.instanceId === selection.instanceId,
          );
          return {
            instance,
            modelSelection: snapshot ? resolveAuxiliaryTextModel(selection, snapshot) : selection,
          };
        }),
      ),
    ),
  );

/**
 * Build a `TextGenerationShape` that routes every call through the
 * registry. Exposed separately from the Layer so tests can construct it
 * against a stub registry without layering gymnastics.
 */
export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>> = Effect.succeed([]),
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(
          registry,
          "generateCommitMessage",
          modelSelection,
          getProviders,
        ).pipe(
          Effect.flatMap(({ instance, modelSelection }) =>
            Effect.promise(() =>
              readRepositoryWritingContext(
                input.cwd,
                instance.driverKind,
                input.writingPreferences,
              ),
            ).pipe(
              Effect.flatMap((repositoryContext) =>
                instance.textGeneration.generateCommitMessage({
                  ...input,
                  modelSelection,
                  repositoryContext,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  generatePrContent: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(registry, "generatePrContent", modelSelection, getProviders).pipe(
          Effect.flatMap(({ instance, modelSelection }) =>
            Effect.promise(() =>
              readRepositoryWritingContext(
                input.cwd,
                instance.driverKind,
                input.writingPreferences,
              ),
            ).pipe(
              Effect.flatMap((repositoryContext) =>
                instance.textGeneration.generatePrContent({
                  ...input,
                  modelSelection,
                  repositoryContext,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  generateBranchName: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(registry, "generateBranchName", modelSelection, getProviders).pipe(
          Effect.flatMap(({ instance: tg, modelSelection }) =>
            tg.textGeneration.generateBranchName({ ...input, modelSelection }),
          ),
        ),
      ),
    ),
  generateThreadTitle: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(
          registry,
          "generateThreadTitle",
          modelSelection,
          getProviders,
        ).pipe(
          Effect.flatMap(({ instance: tg, modelSelection }) =>
            tg.textGeneration.generateThreadTitle({ ...input, modelSelection }),
          ),
        ),
      ),
    ),
  generateStructuredJson: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(
          registry,
          "generateStructuredJson",
          modelSelection,
          getProviders,
        ).pipe(
          Effect.flatMap(({ instance: tg, modelSelection }) =>
            tg.textGeneration.generateStructuredJson({ ...input, modelSelection }),
          ),
        ),
      ),
    ),
});

const defaultCodexModelSelection = (model?: string): ModelSelection =>
  createModelSelection(
    ProviderInstanceId.make("codex"),
    model ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
  );

/**
 * `TextGeneration` Layer wired to the `ProviderInstanceRegistry`. The rest
 * of the server keeps using `yield* TextGeneration` — only the underlying
 * wiring changed from kind-based routing to instance-based routing.
 */
export const TextGenerationLive = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry;
    return makeTextGenerationFromRegistry(registry, providers.getProviders);
  }),
);

const AUXILIARY_DEFAULT_MODELS = new Set([
  "gpt-6-luna",
  "gpt-5.4-mini",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);
const AUXILIARY_FALLBACKS: Record<string, readonly string[]> = {
  codex: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"],
  claudeAgent: ["claude-haiku-5-5", "claude-haiku-4-5"],
};
export function resolveAuxiliaryTextModel(
  selection: ModelSelection,
  snapshot: ServerProvider,
): ModelSelection {
  if (!AUXILIARY_DEFAULT_MODELS.has(selection.model)) return selection;
  if (snapshot.modelCatalog?.status === "failed" || snapshot.modelCatalog?.status === "partial")
    return selection;
  const selected = snapshot.models.find((model) => model.slug === selection.model);
  if (selected?.isUnlisted !== true && (selected || snapshot.modelCatalog?.status !== "complete"))
    return selection;
  const listed = snapshot.models.filter((model) => model.isCustom || !model.isUnlisted);
  const fallback =
    AUXILIARY_FALLBACKS[snapshot.driver]
      ?.map((slug) => listed.find((model) => model.slug === slug))
      .find(Boolean) ?? listed[0];
  return fallback ? { ...selection, model: fallback.slug } : selection;
}
