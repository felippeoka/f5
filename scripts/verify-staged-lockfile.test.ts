import { expect, it } from "vitest";
import { verifyStagedLockfile } from "./verify-staged-lockfile.ts";
const lock = (packages: Record<string, unknown>) => JSON.stringify({ packages });
it("checks version and integrity including duplicate and optional versions", () => {
  const root = lock({
    a: ["a@1.0.0", "", {}, "sha512-first"],
    "a/a": ["a@2.0.0", "", {}, "sha512-second"],
    optional: ["native@1.0.0", "", { os: "darwin" }, "sha512-native"],
  });
  expect(() =>
    verifyStagedLockfile(
      root,
      lock({
        a: ["a@2.0.0", "", {}, "sha512-second"],
        native: ["native@1.0.0", "", {}, "sha512-native"],
      }),
    ),
  ).not.toThrow();
  expect(() =>
    verifyStagedLockfile(root, lock({ a: ["a@3.0.0", "", {}, "sha512-first"] })),
  ).toThrow();
  expect(() =>
    verifyStagedLockfile(root, lock({ a: ["a@1.0.0", "", {}, "sha512-changed"] })),
  ).toThrow();
});
