import { afterEach, expect, it } from "vitest";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifyReleaseAssets, parseReleaseAssetArgs } from "./verify-release-assets.ts";
import { createReleaseFixture } from "./lib/release-fixture.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const value = createReleaseFixture();
  roots.push(value.dir);
  return { ...value, verify: () => verifyReleaseAssets(value.dir, value.version, "beta") };
}

it("accepts a complete verified release", () => {
  fixture().verify();
});
it.each(["F5-0.1.0-beta.1-arm64.dmg", "f5-0.1.0-beta.1-linux-arm64.tar.gz", "f5-cli-release.json"])(
  "rejects missing %s",
  (name) => {
    const f = fixture();
    rmSync(join(f.dir, name));
    expect(f.verify).toThrow(/Missing/);
  },
);
it("rejects unknown files", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "extra"), "");
  expect(f.verify).toThrow(/Unexpected/);
});
it.each(["F5-0.1.0-beta.1-x64.exe", "f5-0.1.0-beta.1-win32-arm64.tar.gz"])(
  "checks size and hash for %s",
  (name) => {
    const f = fixture();
    writeFileSync(join(f.dir, name), "corrupt");
    expect(f.verify).toThrow(/mismatch/);
  },
);
it("rejects wrong manifest versions and CLI URLs", () => {
  const f = fixture();
  const path = join(f.dir, "beta.yml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("version: 0.1.0-beta.1", "version: 9.9.9"),
  );
  expect(f.verify).toThrow(/Version/);
  const other = fixture();
  const cli = join(other.dir, "f5-cli-release.json");
  writeFileSync(
    cli,
    readFileSync(cli, "utf8").replace("https://github.com", "https://evil.example"),
  );
  expect(other.verify).toThrow();
});

it("rejects same-size content with the wrong hash", () => {
  for (const name of ["F5-0.1.0-beta.1-x64.exe", "f5-0.1.0-beta.1-win32-arm64.tar.gz"]) {
    const f = fixture();
    writeFileSync(join(f.dir, name), "artifacx");
    expect(f.verify).toThrow(/mismatch/);
  }
});
it("accepts the AppImage manifest emitted by electron-builder 26.15.3 including blockMapSize", () => {
  const f = fixture();
  const manifest = readFileSync(join(f.dir, "beta-linux.yml"), "utf8");
  expect(manifest).toContain("    blockMapSize: 3");
  expect(manifest).toContain("path: F5-0.1.0-beta.1-x86_64.AppImage");
  f.verify();
});
it("rejects corrupted AppImage manifests and validates argument names", () => {
  const f = fixture();
  const path = join(f.dir, "beta-linux.yml");
  writeFileSync(path, readFileSync(path, "utf8").replace("blockMapSize: 3", "blockMapSize: 300"));
  expect(f.verify).toThrow(/blockMapSize/);
  expect(parseReleaseAssetArgs(["--channel", "beta", f.dir, "--version", f.version])).toEqual({
    dir: f.dir,
    version: f.version,
    channel: "beta",
  });
  expect(() =>
    parseReleaseAssetArgs(["--not-version", f.version, "--channel", "beta", f.dir]),
  ).toThrow();
});
