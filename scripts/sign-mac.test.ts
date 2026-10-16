import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { perFileOptions } = require("./sign-mac.cjs") as {
  perFileOptions(
    options: { optionsForFile(file: string): { entitlements: string } },
    file: string,
  ): { entitlements: string };
};
it("gives the Swift helper a minimal entitlement file while preserving Electron JIT entitlements", () => {
  const options = { optionsForFile: () => ({ entitlements: "electron-jit.plist" }) };
  const swift = perFileOptions(options, "/F5.app/Contents/Resources/native/f5-computer-helper");
  expect(readFileSync(swift.entitlements, "utf8")).not.toContain("<key>");
  expect(perFileOptions(options, "/F5.app/Contents/Frameworks/F5 Helper.app").entitlements).toBe(
    "electron-jit.plist",
  );
  const main = readFileSync(
    new URL("../apps/desktop/resources/entitlements.mac.plist", import.meta.url),
    "utf8",
  );
  expect(main).not.toContain("disable-library-validation");
  expect(main).not.toContain("allow-unsigned-executable-memory");
});
