// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import ts from "typescript";
export function verifyStagedLockfile(rootText: string, stagedText: string): void {
  const entries = (text: string) => {
    const parsed = ts.parseConfigFileTextToJson("bun.lock", text);
    if (parsed.error || !parsed.config?.packages) throw new Error("Invalid Bun lockfile");
    return Object.values(parsed.config.packages) as unknown[][];
  };
  const key = (entry: unknown[]) =>
    JSON.stringify([
      entry[0],
      entry.find((value) => typeof value === "string" && /^sha(256|512)-/.test(value)) ?? null,
    ]);
  const allowed = new Set(entries(rootText).map(key));
  for (const entry of entries(stagedText)) {
    if (typeof entry[0] === "string" && /@(workspace:|file:)/.test(entry[0])) continue;
    if (!allowed.has(key(entry)))
      throw new Error(`Staged dependency is absent from root lockfile: ${entry[0]}`);
  }
}
if (process.argv[1]?.endsWith("verify-staged-lockfile.ts")) {
  const [root, staged] = process.argv.slice(2);
  if (!root || !staged) throw new Error("Usage: verify-staged-lockfile.ts ROOT STAGED");
  verifyStagedLockfile(readFileSync(root, "utf8"), readFileSync(staged, "utf8"));
}
