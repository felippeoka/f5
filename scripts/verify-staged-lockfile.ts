// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import ts from "typescript";
type BunLock = { packages: Record<string, unknown[]> } & Record<string, unknown>;
function parseBunLock(text: string): BunLock {
  const parsed = ts.parseConfigFileTextToJson("bun.lock", text);
  if (parsed.error || !parsed.config?.packages) throw new Error("Invalid Bun lockfile");
  return parsed.config as BunLock;
}
const isLocalPackage = (entry: unknown[]) =>
  typeof entry[0] === "string" && /@(workspace:|file:)/.test(entry[0]);

/**
 * Turns the root lockfile into a lockfile for a single staged package. Bun keeps
 * every locked resolution that still satisfies the staged ranges, including nested
 * duplicate versions, so the stage resolves to root-locked packages instead of the
 * newest registry versions. Workspace packages cannot exist in the stage.
 */
export function seedStagedLockfile(
  rootText: string,
  manifest: {
    readonly name: string;
    readonly dependencies: Record<string, unknown>;
    readonly devDependencies?: Record<string, unknown>;
    readonly overrides?: Record<string, string>;
  },
): string {
  const root = parseBunLock(rootText);
  return `${JSON.stringify(
    {
      lockfileVersion: root.lockfileVersion,
      ...(root.configVersion === undefined ? {} : { configVersion: root.configVersion }),
      workspaces: {
        "": {
          name: manifest.name,
          dependencies: manifest.dependencies,
          ...(manifest.devDependencies ? { devDependencies: manifest.devDependencies } : {}),
        },
      },
      ...(manifest.overrides ? { overrides: manifest.overrides } : {}),
      packages: Object.fromEntries(
        Object.entries(root.packages).filter(([, entry]) => !isLocalPackage(entry)),
      ),
    },
    null,
    2,
  )}\n`;
}

export function verifyStagedLockfile(rootText: string, stagedText: string): void {
  const entries = (text: string) => Object.values(parseBunLock(text).packages);
  const key = (entry: unknown[]) =>
    JSON.stringify([
      entry[0],
      entry.find((value) => typeof value === "string" && /^sha(256|512)-/.test(value)) ?? null,
    ]);
  const allowed = new Set(entries(rootText).map(key));
  for (const entry of entries(stagedText)) {
    if (isLocalPackage(entry)) continue;
    if (!allowed.has(key(entry)))
      throw new Error(`Staged dependency is absent from root lockfile: ${entry[0]}`);
  }
}
if (process.argv[1]?.endsWith("verify-staged-lockfile.ts")) {
  const [root, staged] = process.argv.slice(2);
  if (!root || !staged) throw new Error("Usage: verify-staged-lockfile.ts ROOT STAGED");
  verifyStagedLockfile(readFileSync(root, "utf8"), readFileSync(staged, "utf8"));
}
