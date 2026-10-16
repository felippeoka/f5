import { expect, it } from "vitest";
import { extractReleaseNotes } from "./extract-release-notes.ts";
it("extracts stable and beta with one install footer", () => {
  const text = "## [Unreleased]\nNew\n## [0.1.0] - 2026-10-16\nStable\n## [0.0.1]\nOld";
  expect(extractReleaseNotes(text, "0.1.0")).toContain("Stable\n\n[Installation");
  expect(extractReleaseNotes(text, "0.2.0-beta.1")).toContain("New\n\n[Installation");
  expect(extractReleaseNotes("## [Unreleased]\n", "0.2.0-beta.1")).toContain(
    "No changelog entries.",
  );
  expect(() => extractReleaseNotes(text, "9.0.0")).toThrow();
});
