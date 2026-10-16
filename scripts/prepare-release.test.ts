import { expect, it } from "vitest";
import { validateReleaseVersion, prepareChangelog } from "./prepare-release.ts";
it("enforces stable/beta canonical increasing versions", () => {
  for (const version of [
    "0.1.0-rc.1",
    "0.1.0-preview.1",
    "0.1.0",
    "0.0.9",
    "01.2.3",
    "0.2.0-beta.01",
  ])
    expect(() => validateReleaseVersion(version, "0.1.0")).toThrow();
  expect(() => validateReleaseVersion("0.2.0-beta.1", "0.1.0")).not.toThrow();
});
it("moves Unreleased only for stable", () => {
  const text = "# Changelog\n\n## [Unreleased]\n\nChanges\n\n## [0.0.1]\nOld\n";
  expect(prepareChangelog(text, "0.1.0", "2026-10-16")).toContain(
    "## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\nChanges",
  );
  expect(prepareChangelog(text, "0.1.0-beta.1", "2026-10-16")).toBe(text);
});
