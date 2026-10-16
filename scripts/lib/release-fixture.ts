// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CLI_TARGETS } from "@t3tools/shared/cliRelease";
export function createReleaseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "f5-assets-"));

  const version = "0.1.0-beta.1";
  const content = Buffer.from("artifact");
  const hash = (kind: string, encoding: "hex" | "base64") =>
    createHash(kind).update(content).digest(encoding);
  const manifest = (names: string[]) =>
    `version: ${version}\nfiles:\n${names.map((name) => `  - url: ${name}\n    sha512: ${hash("sha512", "base64")}\n    size: ${content.length}\n`).join("")}releaseDate: '2026-10-16T00:00:00Z'\n`;
  const mac = ["arm64.dmg", "arm64.zip", "x64.dmg", "x64.zip"].map(
    (suffix) => `F5-${version}-${suffix}`,
  );
  const win = `F5-${version}-x64.exe`;
  const linux = `F5-${version}-x86_64.AppImage`;
  for (const name of [...mac, win, linux]) writeFileSync(join(dir, name), content);
  for (const [name, files] of [
    ["beta-mac.yml", mac],
    ["beta.yml", [win]],
    ["beta-linux.yml", [linux]],
  ] as const)
    writeFileSync(
      join(dir, name),
      name.endsWith("-linux.yml")
        ? readFileSync(new URL("../fixtures/appimage-update.yml", import.meta.url), "utf8")
        : manifest([...files]),
    );

  const artifacts = CLI_TARGETS.map((target) => {
    const name = `f5-${version}-${target}.tar.gz`;
    writeFileSync(join(dir, name), content);
    return {
      target,
      url: `https://github.com/lopes-felipe/f5/releases/download/v${version}/${name}`,
      sha256: hash("sha256", "hex"),
      size: content.length,
    };
  });
  writeFileSync(
    join(dir, "f5-cli-release.json"),
    JSON.stringify({ schemaVersion: 1, version, artifacts }),
  );
  writeFileSync(join(dir, "SHA256SUMS"), "");
  return { dir, version };
}
