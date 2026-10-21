import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  readonly workspaces?: ReadonlyArray<string> | { readonly packages: ReadonlyArray<string> };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface MissingDependency {
  readonly manifest: string;
  readonly dependency: string;
}

export type EnsureDependenciesResult =
  | { readonly status: "ready"; readonly installed: boolean }
  | { readonly status: "install-failed" }
  | { readonly status: "missing"; readonly missing: ReadonlyArray<MissingDependency> };

const INSTALL_COMMAND = "bun install --frozen-lockfile";
const INSTALL_STAMP = Path.join("node_modules", ".f5-install-stamp");

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function isInstalled(root: string, directory: string, dependency: string): boolean {
  // Check manifests directly: asset-only packages need no JavaScript entry point,
  // and package exports may hide package.json from require.resolve.
  for (let current = directory; ; current = Path.dirname(current)) {
    if (existsSync(Path.join(current, "node_modules", dependency, "package.json"))) return true;
    if (current === root || Path.dirname(current) === current) return false;
  }
}

export function findMissingDependencies(repositoryRoot: string): ReadonlyArray<MissingDependency> {
  const root = Path.resolve(repositoryRoot);
  const manifest = readManifest(Path.join(root, "package.json"));
  const workspaces = manifest.workspaces;
  const patterns =
    workspaces && "packages" in workspaces ? workspaces.packages : (workspaces ?? []);
  const manifests = [
    "package.json",
    ...globSync(
      patterns.map((pattern) => `${pattern}/package.json`),
      { cwd: root },
    )
      .map((path) => path.split(Path.sep).join("/"))
      .sort(),
  ];
  const missing: MissingDependency[] = [];
  for (const relativePath of manifests) {
    const absolutePath = Path.join(root, relativePath);
    const workspace = readManifest(absolutePath);
    const dependencies = { ...workspace.dependencies, ...workspace.devDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!isInstalled(root, Path.dirname(absolutePath), dependency)) {
        missing.push({ manifest: relativePath, dependency });
      }
    }
  }
  return missing;
}

export function lockfileFingerprint(repositoryRoot: string): string | undefined {
  const lockfile = Path.join(repositoryRoot, "bun.lock");
  if (!existsSync(lockfile)) return undefined;
  return createHash("sha256").update(readFileSync(lockfile)).digest("hex");
}

// Presence checks miss version bumps of packages that are already installed, so
// the stamp records which lockfile the current node_modules was installed from.
export function isInstallStale(repositoryRoot: string): boolean {
  const fingerprint = lockfileFingerprint(repositoryRoot);
  if (fingerprint === undefined) return false;
  const stamp = Path.join(repositoryRoot, INSTALL_STAMP);
  return !existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== fingerprint;
}

function writeInstallStamp(repositoryRoot: string): void {
  const fingerprint = lockfileFingerprint(repositoryRoot);
  if (fingerprint === undefined) return;
  const stamp = Path.join(repositoryRoot, INSTALL_STAMP);
  mkdirSync(Path.dirname(stamp), { recursive: true });
  writeFileSync(stamp, `${fingerprint}\n`);
}

function formatMissing(missing: ReadonlyArray<MissingDependency>): string {
  return missing.map(({ manifest, dependency }) => `${manifest}: ${dependency}`).join(", ");
}

export function ensureDependencies(
  repositoryRoot: string,
  options: { readonly install: () => boolean; readonly log?: (message: string) => void },
): EnsureDependenciesResult {
  const root = Path.resolve(repositoryRoot);
  const log = options.log ?? console.log;
  const missing = findMissingDependencies(root);
  if (missing.length === 0 && !isInstallStale(root)) return { status: "ready", installed: false };
  const reason =
    missing.length > 0
      ? `missing: ${formatMissing(missing)}`
      : "bun.lock changed since last install";
  log(`Dependencies are out of date (${reason}). Running \`${INSTALL_COMMAND}\`...`);
  if (!options.install()) return { status: "install-failed" };
  const remaining = findMissingDependencies(root);
  if (remaining.length > 0) return { status: "missing", missing: remaining };
  writeInstallStamp(root);
  return { status: "ready", installed: true };
}

function reportMissing(missing: ReadonlyArray<MissingDependency>): void {
  console.error("Dependencies are missing from the local installation:");
  for (const { manifest, dependency } of missing) {
    console.error(`  ${manifest}: ${dependency}`);
  }
  console.error(`\nRun \`${INSTALL_COMMAND}\` from the repository root, then retry.`);
}

function bunExecutable(): string {
  const execPath = process.env.npm_execpath;
  return execPath && Path.basename(execPath).startsWith("bun") ? execPath : "bun";
}

if (import.meta.main) {
  const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--install") && !process.env.CI) {
    const result = ensureDependencies(root, {
      install: () =>
        spawnSync(bunExecutable(), ["install", "--frozen-lockfile"], {
          cwd: root,
          stdio: "inherit",
        }).status === 0,
    });
    if (result.status === "install-failed") {
      console.error(`\n\`${INSTALL_COMMAND}\` failed. Fix the error above, then retry.`);
      process.exitCode = 1;
    } else if (result.status === "missing") {
      reportMissing(result.missing);
      process.exitCode = 1;
    }
  } else {
    const missing = findMissingDependencies(root);
    if (missing.length > 0) {
      reportMissing(missing);
      process.exitCode = 1;
    }
  }
}
