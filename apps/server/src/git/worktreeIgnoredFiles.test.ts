import { expect, it } from "vitest";
import { blockingIgnoredEntries } from "./worktreeIgnoredFiles.ts";

it("keeps automatic cleanup's node_modules exception without approving other ignored paths", () => {
  expect(
    blockingIgnoredEntries(["node_modules/", "apps/web/node_modules/", ".env", "dist/"]),
  ).toEqual([".env", "dist/"]);
});

it("requires explicit approval of every ignored path for manual removal", () => {
  const entries = ["node_modules/", "dist/", ".env"];
  expect(blockingIgnoredEntries(entries, undefined, true)).toEqual(entries);
  expect(blockingIgnoredEntries(entries, entries, true)).toEqual([]);
  expect(blockingIgnoredEntries([...entries, ".env.local"], entries, true)).toEqual([".env.local"]);
});

it("does not treat parent, wildcard, or similar directory names as approval", () => {
  expect(
    blockingIgnoredEntries(["dist/", "dist-private/", ".env"], ["dist", "*", "../.env"], true),
  ).toEqual(["dist/", "dist-private/", ".env"]);
});

it("rejects newly appearing node_modules after a manual review", () => {
  expect(blockingIgnoredEntries([".env", "node_modules/"], [".env"])).toEqual(["node_modules/"]);
});
