import { expect, it } from "vitest";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { resolveOneOffPromptRoute } from "./oneOffPromptRouting";

it("preserves a model owned by a known session provider", () => {
  expect(
    resolveOneOffPromptRoute({ model: "gpt-future-agent", sessionProviderName: "codex" }),
  ).toEqual({ provider: "codex", model: "gpt-future-agent" });
  expect(
    resolveOneOffPromptRoute({ model: "claude-opus-6", sessionProviderName: "claudeAgent" }),
  ).toEqual({ provider: "claudeAgent", model: "claude-opus-6" });
});
it("keeps the static guard on the inferred route", () => {
  expect(resolveOneOffPromptRoute({ model: "gpt-future-agent" }).model).toBe(
    DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  );
});
