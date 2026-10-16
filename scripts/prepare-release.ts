// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { updateReleasePackageVersions } from "./update-release-package-versions.ts";
export function validateReleaseVersion(version: string, current: string): void {
  versionToken(version);
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))
    throw new Error("Only stable and beta.N releases are supported.");
  if (compareCliReleaseVersions(version, current) <= 0)
    throw new Error("Release version must increase.");
}
export function prepareChangelog(text: string, version: string, date: string): string {
  if (version.includes("-")) return text;
  if (!/^## \[Unreleased\]\s*$/m.test(text))
    throw new Error("Missing Unreleased changelog section");
  return text.replace(
    /^## \[Unreleased\]\s*\n/m,
    `## [Unreleased]\n\n## [${version}] - ${date}\n\n`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? "";
  const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version as string;
  validateReleaseVersion(version, current);
  const changelog = prepareChangelog(
    readFileSync("CHANGELOG.md", "utf8"),
    version,
    new Date().toISOString().slice(0, 10),
  );
  updateReleasePackageVersions(version);
  writeFileSync("CHANGELOG.md", changelog);
  const install = spawnSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("Lockfile update failed");
  console.log(
    `git switch -c release/${version}\ngit add apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json bun.lock CHANGELOG.md\ngit commit -m "Release ${version}"\ngit push -u origin release/${version}\ngh pr create --title "Release ${version}" --body "Prepare F5 ${version}."`,
  );
}
