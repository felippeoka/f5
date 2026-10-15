/**
 * MuseTextGeneration — git/thread text generation through an ephemeral
 * Muse Code session pinned to the read-only permission profile. The SDK's
 * `requirePermissionProfile` read-back must prove the profile applied, or
 * generation fails without running the prompt.
 *
 * @module git/Layers/MuseTextGeneration
 */
import type { Item } from "@muse-code/sdk/dist/src/msp.js";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type MuseSettings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import {
  MUSE_READ_ONLY_PERMISSION_PROFILE,
  MUSE_SERVE_ARGS,
} from "@t3tools/shared/museProtocolManifest";
import { Effect, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  describeMspError,
  MuseCliError,
  openMspHost,
} from "../../provider/msp/MspSessionRuntime.ts";
import { makeMspTransport } from "../../provider/msp/MspTransport.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  type TextGenerationShape,
  type ThreadTitleGenerationResult,
} from "../Services/TextGeneration.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";

const MUSE_TEXT_GENERATION_TIMEOUT_MS = 180_000;

/** Runs one prompt in a fresh read-only session and returns the agent's text. */
export type MusePromptRunner = (input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly modelId: string | undefined;
}) => Effect.Effect<string, MuseCliError, ChildProcessSpawner.ChildProcessSpawner>;

export const runMuseReadOnlyPrompt =
  (settings: MuseSettings, environment: NodeJS.ProcessEnv): MusePromptRunner =>
  (input) =>
    Effect.gen(function* () {
      const transport = yield* makeMspTransport({
        binaryPath: settings.binaryPath || "muse",
        args: MUSE_SERVE_ARGS,
        cwd: input.cwd,
        environment,
      });
      return yield* Effect.tryPromise({
        try: async () => {
          const host = await openMspHost({
            transport: transport.transport,
            clientVersion: "0.0.0",
          });
          try {
            const session = await host.client.startSession({
              workspaceRoot: input.cwd,
              approvalMode: "denyUnmatched",
              permissionProfile: MUSE_READ_ONLY_PERMISSION_PROFILE,
              requirePermissionProfile: true,
              ...(input.modelId ? { modelId: input.modelId } : {}),
            });
            const turn = await session.sendUserTurn({
              input: [{ type: "text", text: input.prompt }],
            });
            const texts = new Map<string, string>();
            const collect = (async () => {
              for await (const item of turn.items()) {
                const folded = item as Item;
                if (folded.kind === "agentMessage" && typeof folded.text === "string") {
                  texts.set(folded.itemId, folded.text);
                }
              }
            })();
            const outcome = await turn.completed;
            await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, 100))]);
            if (outcome.kind !== "completed" || outcome.params.terminal !== "completed") {
              throw new Error(
                outcome.kind === "completed"
                  ? (outcome.params.error?.message ?? `Muse Code turn ${outcome.params.terminal}.`)
                  : "Muse Code turn did not complete.",
              );
            }
            return [...texts.values()].join("\n").trim();
          } finally {
            await host.close().catch(() => undefined);
          }
        },
        catch: (cause) => new MuseCliError({ message: describeMspError(cause), cause }),
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof MuseCliError
          ? cause
          : new MuseCliError({ message: `Failed to start Muse Code: ${cause.message}`, cause }),
      ),
      Effect.scoped,
    );

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateStructuredJson"
  | (string & {});

export const makeMuseTextGeneration = Effect.fn("makeMuseTextGeneration")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly runPrompt?: MusePromptRunner },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runPrompt = options?.runPrompt ?? runMuseReadOnlyPrompt(settings, environment);

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection | undefined;
    readonly model: string | undefined;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const modelId =
        input.modelSelection?.model ??
        input.model ??
        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.muse;
      const result = yield* runPrompt({ cwd: input.cwd, prompt: input.prompt, modelId }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(MUSE_TEXT_GENERATION_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: `Muse Code text generation failed: ${cause.message}`,
              cause,
            }),
        ),
      );
      if (Option.isNone(result)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Muse Code text generation timed out.",
        });
      }
      if (!result.value) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Muse Code returned empty output.",
        });
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
        extractJsonObject(result.value),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "Muse Code returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "MuseTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      repositoryContext: input.repositoryContext,
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      writingPreferences: input.writingPreferences,
    });
    const generated = yield* runJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "MuseTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      repositoryContext: input.repositoryContext,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      writingPreferences: input.writingPreferences,
    });
    const generated = yield* runJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "MuseTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      writingPreferences: input.writingPreferences,
    });
    const generated = yield* runJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "MuseTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      previousTitle: input.previousTitle,
      attachments: input.attachments,
    });
    const generated = yield* runJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return {
      ...(generated.needsRefinement !== undefined
        ? { needsRefinement: generated.needsRefinement }
        : {}),
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  const generateStructuredJson: TextGenerationShape["generateStructuredJson"] = Effect.fn(
    "MuseTextGeneration.generateStructuredJson",
  )(function* (input) {
    return yield* runJson({
      operation: input.operation,
      cwd: input.cwd,
      prompt: input.prompt,
      outputSchemaJson: input.outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateStructuredJson,
  } satisfies TextGenerationShape;
});
