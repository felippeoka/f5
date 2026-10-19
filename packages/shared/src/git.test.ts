import { describe, expect, it } from "vitest";
import { gitConfigArgs, literalGitPathspec } from "./git";

describe("Git argument boundaries", () => {
  it("preserves pathspec magic and wildcard filenames as literal paths", () => {
    expect(literalGitPathspec(":(glob)**")).toBe(":(literal):(glob)**");
    expect(literalGitPathspec("src/[a]*.ts")).toBe(":(literal)src/[a]*.ts");
  });
  it("permits app-owned safety and durability overrides", () => {
    expect(
      gitConfigArgs([
        ["status.showUntrackedFiles", "all"],
        ["core.fsyncMethod", "batch"],
      ]),
    ).toEqual(["-c", "status.showUntrackedFiles=all", "-c", "core.fsyncMethod=batch"]);
  });
  it("rejects executable overrides, includes and multiline values", () => {
    for (const key of ["core.sshCommand", "alias.run", "include.path", "--global"])
      expect(() => gitConfigArgs([[key, "payload"]])).toThrow("Unsupported");
    expect(() => gitConfigArgs([["core.fsmonitor", "false\ninclude.path=x"]])).toThrow(
      "Unsupported",
    );
  });
});
