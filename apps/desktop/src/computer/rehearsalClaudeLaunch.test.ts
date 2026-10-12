import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { rehearsalClaudeLaunch, rehearsalClaudeAuthentication } from "./rehearsalClaudeLaunch";

it("keeps transcript state isolated and forwards CLI arguments with only selected credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-launch-test-"));
  try {
    const wrapper = join(root, "wrapper.cjs");
    const fixture = join(root, "fixture.cjs");
    const credentials = join(root, "selected-account ' $() ` credential scope");
    const config = join(root, "isolated-transcripts");
    await writeFile(wrapper, rehearsalClaudeLaunch(process.execPath, credentials));
    await writeFile(
      fixture,
      `process.stdout.write(JSON.stringify({
      args:process.argv.slice(2),config:process.env.CLAUDE_CONFIG_DIR,
      credentials:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      home:process.env.HOME,user:process.env.USER
    }));`,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [wrapper, fixture, "--sdk", "argument ' $() `"],
      {
        timeout: 10000,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "another-account",
          HOME: root,
          USER: "synthetic-user",
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      args: ["--sdk", "argument ' $() `"],
      config,
      credentials,
      home: userInfo().homedir,
      user: userInfo().username,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses paths that would resolve against an unrelated working directory", () => {
  expect(() => rehearsalClaudeLaunch("claude", join(tmpdir(), "credentials"))).toThrow();
  expect(() => rehearsalClaudeLaunch(process.execPath, "relative-credentials")).toThrow();
});

it("preserves a native CLI failure without printing its arguments or credential location", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-launch-exit-"));
  try {
    const wrapper = join(root, "wrapper.cjs");
    await writeFile(wrapper, rehearsalClaudeLaunch(process.execPath, join(root, "credentials")));
    await expect(
      promisify(execFile)(process.execPath, [wrapper, "-e", "process.exit(7)"], { timeout: 10000 }),
    ).rejects.toMatchObject({ code: 7, stdout: "", stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps only strict authentication state and discards account data and errors", () => {
  expect(
    rehearsalClaudeAuthentication('{"loggedIn":true,"email":"PRIVATE_SENTINEL"}', true),
  ).toEqual({
    status: "authenticated",
    credentialFileCopied: true,
    selectedProfileSecureStorage: true,
  });
  expect(rehearsalClaudeAuthentication('{"loggedIn":false}', false).status).toBe("unauthenticated");
  for (const value of [
    null,
    undefined,
    '{"loggedIn":"true"}',
    '{"loggedIn":1}',
    "PRIVATE_SENTINEL",
  ]) {
    const result = rehearsalClaudeAuthentication(value, false);
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  }
});
