import { join } from "node:path";
import type { ScenarioInstance } from "./catalog";
import type { Target } from "./identity";
import { helperPath } from "./identity";

export interface Command {
  readonly executable: string;
  readonly args: readonly string[];
  readonly check?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}
export interface ProviderLaunch {
  readonly home: string;
  readonly binary: string;
  readonly model?: string;
}
export type Launches = Partial<Record<"claude" | "codex", ProviderLaunch>>;
export function commandsFor(
  s: ScenarioInstance,
  target: Target,
  output: string,
  launches: Launches,
  hostPlatform: string = process.platform,
  clusterWorkflow = false,
): readonly Command[] | string {
  const bun = (args: string[], check?: string, timeoutMs = 30 * 60_000): Command => ({
    executable: "bun",
    args,
    timeoutMs,
    ...(check ? { check } : {}),
  });
  if (s.runner === "quality")
    return [
      bun(["run", "fmt:check"], "format"),
      bun(["run", "lint"], "lint"),
      bun(["run", "typecheck"], "typecheck"),
      bun(["run", "test:full"], "full-tests"),
    ];
  if (s.runner === "browser-smoke")
    return [
      bun(["run", "--cwd", "apps/web", "test:browser"], "browser-tests"),
      bun(["run", "test:desktop-smoke"], "desktop-smoke"),
      {
        executable: "node",
        args: ["scripts/profile-lifecycle-smoke.cjs"],
        check: "profile-lifecycle",
        timeoutMs: 180000,
      },
    ];
  if (s.runner === "native-tests") {
    if (hostPlatform !== target.platform) return "interactive-platform-unavailable";
    return [
      {
        executable: "node",
        args: ["scripts/generate-computer-tiers.ts", "--check"],
        check: "tier-drift",
        timeoutMs: 30000,
      },
      target.platform === "darwin"
        ? {
            executable: "swift",
            args: ["test", "--package-path", "apps/desktop/native/macos"],
            check: "native-tests",
            timeoutMs: 180000,
          }
        : {
            executable: "cargo",
            args: ["test", "--manifest-path", "apps/desktop/native/windows/Cargo.toml"],
            check: "native-tests",
            timeoutMs: 300000,
          },
      {
        executable: "node",
        args: [
          "scripts/build-computer-helper.ts",
          "--platform",
          target.platform === "darwin" ? "mac" : "win",
          "--arch",
          process.arch === "arm64" ? "arm64" : "x64",
          "--check",
        ],
        check: "helper-protocol",
        timeoutMs: 300000,
      },
      ...(target.platform === "win32"
        ? [
            {
              executable: "cargo",
              args: [
                "test",
                "--locked",
                "--manifest-path",
                "apps/desktop/native/windows/fixture/Cargo.toml",
              ],
              check: "native-fixture-tests",
              timeoutMs: 300000,
            },
            {
              executable: "cargo",
              args: [
                "run",
                "--locked",
                "--manifest-path",
                "apps/desktop/native/windows/fixture/Cargo.toml",
                "--",
                "--check",
              ],
              check: "native-fixture-protocol",
              timeoutMs: 300000,
            },
          ]
        : []),
    ];
  }
  if (s.runner === "builtin") return "supported-launch-consent-veto-unavailable";
  if (s.runner === "chrome")
    return s.selectedProvider === "codex"
      ? "supported-isolated-chrome-runtime-unavailable"
      : "chrome-certification-descriptor-missing";
  if (s.runner === "package")
    return target.app ? "installed-attribution-proof-required" : "signing-deferred";
  if (hostPlatform !== target.platform) return "interactive-platform-unavailable";
  // The development wrapper must NEVER be used against installed/signed apps.
  if (target.app) return "installed-observation-driver-required";
  if (target.platform === "win32") return "windows-interactive-driver-required";
  if (s.runner.startsWith("electron") || s.runner === "windows-closed") {
    const provider = s.selectedProvider!;
    const launch = launches[provider];
    if (!launch) return "provider-launch-not-configured";
    const flags: Record<string, string[]> = {
      electron: clusterWorkflow ? ["--cluster-workflows"] : [],
      "electron-discovery": ["--status-only"],
      "electron-real-apps": ["--real-apps"],
      "electron-chromium": ["--chromium-fixture"],
      "electron-grant-memory": ["--grant-memory"],
      "windows-closed": ["--windows-closed"],
      "electron-main-stop": ["--stop-main", "--diagnose-chord"],
      "electron-renderer-stop": ["--stop-renderer", "--diagnose-chord"],
    };
    if (!(s.runner in flags)) return "scenario-driver-required";
    return [
      {
        ...bun([
          "apps/desktop/scripts/rehearse-computer-electron.mjs",
          "--provider",
          provider,
          "--" + provider + "-home",
          launch.home,
          "--" + provider + "-binary",
          launch.binary,
          "--output",
          output,
          ...(target.fixtureDirectory ? ["--fixture-bin-dir", target.fixtureDirectory] : []),
          ...flags[s.runner]!,
          ...(launch.model ? ["--model", launch.model] : []),
        ]),
        env: { F5_COMPUTER_ELECTRON_REHEARSAL: "1" },
      },
    ];
  }
  const native: Record<string, { source: string; args: string[]; env: Record<string, string> }> = {
    capture: { source: "rehearseHelperMacos.ts", args: ["--privacy-only"], env: {} },
    "protected-apps": {
      source: "rehearseProtectedAppsMacos.ts",
      args: [],
      env: { F5_COMPUTER_PROTECTION_REHEARSAL: "1" },
    },
    "backend-stop": {
      source: "rehearseStopMacos.ts",
      args: ["--freeze-backend"],
      env: { F5_COMPUTER_STOP_REHEARSAL: "1" },
    },
  };
  const spec = native[s.runner];
  if (!spec) return "scenario-driver-required";
  return [
    {
      ...bun([
        join("apps/desktop/src/computer", spec.source),
        "--helper",
        helperPath(target),
        "--output",
        output,
        ...spec.args,
        ...(target.fixtureDirectory ? ["--fixture-bin-dir", target.fixtureDirectory] : []),
      ]),
      env: spec.env,
    },
  ];
}
