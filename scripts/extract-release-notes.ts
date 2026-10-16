// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, writeFileSync } from "node:fs";
export function extractReleaseNotes(changelog: string, version: string): string {
  const heading = version.includes("-beta.") ? "Unreleased" : version;
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${heading}]`));
  if (start < 0 && heading !== "Unreleased")
    throw new Error(`Missing changelog section ${heading}`);
  let end = start + 1;
  while (end < lines.length && !lines[end]?.startsWith("## ")) end++;
  const body =
    start < 0
      ? ""
      : lines
          .slice(start + 1, end)
          .join("\n")
          .trim();
  return `${body || "No changelog entries."}\n\n[Installation and upgrade instructions](https://github.com/lopes-felipe/f5/blob/main/docs/install.md)\n`;
}
if (process.argv[1]?.endsWith("extract-release-notes.ts")) {
  const [version, output] = process.argv.slice(2);
  if (!version || !output) throw new Error("Usage: extract-release-notes.ts VERSION OUTPUT");
  writeFileSync(output, extractReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), version));
}
