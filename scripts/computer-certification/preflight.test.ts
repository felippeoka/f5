import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthenticationReady } from "./preflight";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "f5-readiness-test-"));
  roots.push(root);
  return root;
}
type ExecuteFile = NonNullable<Parameters<typeof codexAuthenticationReady>[1]>;

it("checks login status in the selected home and discards account output", async () => {
  const root = await home();
  await writeFile(join(root, "auth.json"), "{}");
  const execute = vi.fn<ExecuteFile>().mockResolvedValue({
    stdout: "",
    stderr: "Logged in using ChatGPT PRIVATE_ACCOUNT_SENTINEL",
  });
  expect(await codexAuthenticationReady({ binary: "/selected/codex", home: root }, execute)).toBe(
    true,
  );
  expect(execute).toHaveBeenCalledWith(
    "/selected/codex",
    ["login", "status"],
    expect.objectContaining({
      env: expect.objectContaining({ CODEX_HOME: root }),
      timeout: 15000,
    }),
  );
});

it("fails readiness without credentials or when the CLI status probe fails", async () => {
  const root = await home();
  const execute = vi.fn<ExecuteFile>().mockRejectedValue(new Error("PRIVATE_ACCOUNT_SENTINEL"));
  expect(await codexAuthenticationReady({ binary: "/selected/codex", home: root }, execute)).toBe(
    false,
  );
  expect(execute).not.toHaveBeenCalled();
  await writeFile(join(root, "auth.json"), "{}");
  expect(await codexAuthenticationReady({ binary: "/selected/codex", home: root }, execute)).toBe(
    false,
  );
  expect(execute).toHaveBeenCalledOnce();
});
