// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { CLI_TARGETS, parseRelease } from "@t3tools/shared/cliRelease";
import { parseDesktopUpdateManifest } from "./desktop-update-manifest.ts";
export function verifyReleaseAssets(dir: string, version: string, channel: string): void {
  if (channel !== "latest" && channel !== "beta") throw new Error("Invalid channel");
  const installers = [
    `F5-${version}-arm64.dmg`,
    `F5-${version}-arm64.zip`,
    `F5-${version}-x64.dmg`,
    `F5-${version}-x64.zip`,
    `F5-${version}-x64.exe`,
    `F5-${version}-x86_64.AppImage`,
  ];
  const manifests = [`${channel}.yml`, `${channel}-mac.yml`, `${channel}-linux.yml`];
  const cli = CLI_TARGETS.map((target) => `f5-${version}-${target}.tar.gz`);
  const required = [...installers, ...manifests, ...cli, "f5-cli-release.json", "SHA256SUMS"];
  const allowed = new Set([...required, ...installers.map((name) => `${name}.blockmap`)]);
  const names = readdirSync(dir);
  for (const name of required) if (!names.includes(name)) throw new Error(`Missing asset: ${name}`);
  for (const name of names)
    if (!allowed.has(name) || !statSync(join(dir, name)).isFile())
      throw new Error(`Unexpected asset: ${name}`);
  const verify = (
    name: string,
    size: number,
    hash: string,
    algorithm: string,
    encoding: "base64" | "hex",
  ) => {
    if (basename(name) !== name || !names.includes(name))
      throw new Error(`Invalid asset path: ${name}`);
    const bytes = readFileSync(join(dir, name));
    if (bytes.length !== size || createHash(algorithm).update(bytes).digest(encoding) !== hash)
      throw new Error(`Asset checksum/size mismatch: ${name}`);
  };
  for (const name of manifests) {
    const expected =
      name === `${channel}-mac.yml`
        ? installers.slice(0, 4)
        : name === `${channel}.yml`
          ? [installers[4]!]
          : [installers[5]!];
    const manifest = parseDesktopUpdateManifest(readFileSync(join(dir, name), "utf8"), name);
    if (manifest.version !== version) throw new Error(`Version mismatch: ${name}`);
    for (const file of manifest.files) {
      if (!installers.includes(file.url)) throw new Error(`Unexpected desktop URL: ${file.url}`);
      verify(file.url, file.size, file.sha512, "sha512", "base64");
      if (file.blockMapSize !== undefined && file.blockMapSize > file.size)
        throw new Error(`Invalid blockMapSize: ${file.url}`);
    }
    if (
      manifest.files.length !== expected.length ||
      expected.some((url) => !manifest.files.some((file) => file.url === url))
    )
      throw new Error(`Incomplete manifest: ${name}`);
    if (manifest.extras.path !== undefined || manifest.extras.sha512 !== undefined) {
      const entry = manifest.files.find((file) => file.url === manifest.extras.path);
      if (!entry || entry.sha512 !== manifest.extras.sha512)
        throw new Error(`Invalid primary asset: ${name}`);
    }
  }
  const release = parseRelease(JSON.parse(readFileSync(join(dir, "f5-cli-release.json"), "utf8")));
  if (release.version !== version || release.artifacts.length !== CLI_TARGETS.length)
    throw new Error("CLI version/target mismatch");
  for (const target of CLI_TARGETS) {
    const artifact = release.artifacts.find((entry) => entry.target === target);
    const name = `f5-${version}-${target}.tar.gz`;
    if (
      !artifact ||
      artifact.url !== `https://github.com/lopes-felipe/f5/releases/download/v${version}/${name}`
    )
      throw new Error(`Invalid CLI URL: ${target}`);
    verify(name, artifact.size, artifact.sha256, "sha256", "hex");
  }
}
export function parseReleaseAssetArgs(args: string[]): {
  dir: string;
  version: string;
  channel: string;
} {
  let version: string | undefined;
  let channel: string | undefined;
  let dir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--version" && !version) version = args[++index];
    else if (arg === "--channel" && !channel) channel = args[++index];
    else if (arg.startsWith("--") || dir) throw new Error(`Unexpected argument: ${arg}`);
    else dir = arg;
  }
  if (!version || !channel || !dir || version.startsWith("--") || channel.startsWith("--"))
    throw new Error("Usage: verify-release-assets.ts --version V --channel C DIR");
  return { dir, version, channel };
}
if (process.argv[1]?.endsWith("verify-release-assets.ts")) {
  const { dir, version, channel } = parseReleaseAssetArgs(process.argv.slice(2));
  verifyReleaseAssets(dir, version, channel);
}
