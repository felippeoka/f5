import { expect, it } from "vitest";
import { seedStagedLockfile, verifyStagedLockfile } from "./verify-staged-lockfile.ts";
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
it("seeds a single-package lockfile from the root lock without workspace packages", () => {
  const root = JSON.stringify({
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: { "": { name: "monorepo" }, "apps/server": { name: "t3" } },
    overrides: { vite: "^8.0.0" },
    catalog: { effect: "1.0.0" },
    packages: {
      a: ["a@1.0.0", "", {}, "sha512-a"],
      "b/a": ["a@2.0.0", "", {}, "sha512-a2"],
      t3: ["t3@workspace:apps/server"],
    },
  });
  const seeded = JSON.parse(
    seedStagedLockfile(root, {
      name: "f5-desktop",
      dependencies: { a: "^1.0.0" },
      devDependencies: { electron: "40.6.0" },
      overrides: { vite: "^8.0.0" },
    }),
  );
  expect(seeded).toEqual({
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: "f5-desktop",
        dependencies: { a: "^1.0.0" },
        devDependencies: { electron: "40.6.0" },
      },
    },
    overrides: { vite: "^8.0.0" },
    packages: {
      a: ["a@1.0.0", "", {}, "sha512-a"],
      "b/a": ["a@2.0.0", "", {}, "sha512-a2"],
    },
  });
  expect(() => verifyStagedLockfile(root, JSON.stringify(seeded))).not.toThrow();
});
