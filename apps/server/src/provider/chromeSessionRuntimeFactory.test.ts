import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHROME_NATIVE_HOST_CERTIFICATIONS,
  type ChromeNativeHostDescriptor,
} from "./chromeNativeHost";
import { chromeCertificationAvailability } from "./chromeSessionRuntimeFactory";

const descriptor: ChromeNativeHostDescriptor = {
  provider: "claude",
  certified: true,
  hostNames: ["fixture"],
  browsers: ["fixture"],
  expectedTarget: () => "/fixture",
  verifyServer: () => true,
  runtime: {
    platform: "darwin",
    arch: "arm64",
    sdkVersion: "fixture",
    executableSha256: "a".repeat(64),
    evidence: "fixture-only",
    locations: () => [],
  },
};
describe("Chrome executable certification", () => {
  const base = {
    provider: "claude" as const,
    descriptors: [descriptor],
    masterEnabled: true,
    platform: "darwin",
    arch: "arm64",
    executableSha256: "a".repeat(64),
  };
  it.each([
    [{ descriptors: [] }, "not-certified"],
    [{ masterEnabled: false }, "not-certified"],
    [{ arch: "x64" }, "platform"],
    [{ executableSha256: "b".repeat(64) }, "executable-drift"],
    [{ executableSha256: "" }, "unverifiable"],
  ])("reports the specific drift or gate reason (%s)", (patch, reason) => {
    expect(chromeCertificationAvailability({ ...base, ...patch })).toMatchObject({
      unavailable: { reason },
    });
  });
  it("accepts only the matching certified executable", () => {
    expect(chromeCertificationAvailability(base)).toEqual({ descriptor });
  });
  it("requires re-certification or descriptor removal when the pinned SDK changes", () => {
    const sdk = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
      .dependencies["@anthropic-ai/claude-agent-sdk"];
    for (const entry of CHROME_NATIVE_HOST_CERTIFICATIONS)
      if (entry.certified && entry.provider === "claude")
        expect(entry.runtime?.sdkVersion).toBe(sdk);
  });
});
