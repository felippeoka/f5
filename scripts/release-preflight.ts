// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { releasePackageFiles } from "./update-release-package-versions.ts";
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();
const dryRun = process.env.DRY_RUN === "true";
const ref = process.env.GITHUB_REF_NAME ?? "";
const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version as string;
let version: string;
if (dryRun) {
  if (ref !== "main") throw new Error("Dry runs require main");
  version = `${current.split("-")[0]}-dryrun.${process.env.GITHUB_RUN_NUMBER}`;
} else {
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(ref)) throw new Error("Invalid release tag");
  version = versionToken(ref.slice(1));
  for (const file of releasePackageFiles)
    if (JSON.parse(readFileSync(file, "utf8")).version !== version)
      throw new Error(`Version mismatch: ${file}`);
  const sha = run("git", ["rev-parse", "HEAD"]);
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const runs = JSON.parse(
    run("gh", [
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&status=success`,
    ]),
  ) as { workflow_runs: unknown[] };
  if (!runs.workflow_runs.length) throw new Error("No successful CI push run for release SHA");
  const releases = JSON.parse(
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`,
    ]),
  ) as { tag_name: string; draft: boolean }[][];
  for (const release of releases.flat())
    if (
      !release.draft &&
      /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(release.tag_name) &&
      compareCliReleaseVersions(version, release.tag_name.slice(1)) <= 0
    )
      throw new Error(`Version must exceed ${release.tag_name}`);
  if (!version.includes("-") && !readFileSync("CHANGELOG.md", "utf8").includes(`## [${version}]`))
    throw new Error("Stable release needs changelog entry");
}
const beta = version.includes("-beta.");
appendFileSync(
  process.env.GITHUB_OUTPUT!,
  `version=${version}\ntag=v${version}\nchannel=${beta ? "beta" : "latest"}\nis_prerelease=${beta}\ndry_run=${dryRun}\n`,
);
