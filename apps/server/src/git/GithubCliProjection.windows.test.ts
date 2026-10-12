import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { secureGithubPaths } from "./GithubCliProjection";

it.skipIf(process.platform !== "win32")(
  "Windows projection ACLs grant only the current identity and disable inherited access",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "f5-private-acl-"));
    const file = path.join(directory, "credentials.json");
    await fs.writeFile(file, "synthetic fixture");
    try {
      await secureGithubPaths([
        { path: directory, directory: true },
        { path: file, directory: false },
      ]);
      const script =
        "$ErrorActionPreference = 'Stop'; " +
        "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
        `$paths = ConvertFrom-Json '${JSON.stringify([directory, file]).replaceAll("'", "''")}'; ` +
        "$results = foreach ($item in $paths) { " +
        "$acl = Get-Acl -LiteralPath $item; " +
        "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); " +
        "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; " +
        "ownerMatches = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Equals($sid); " +
        "ruleCount = $rules.Count; currentIdentityOnly = ($rules.Count -eq 1 -and $rules[0].IdentityReference.Equals($sid)); " +
        "fullControl = ($rules.Count -eq 1 -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl') } }; " +
        "ConvertTo-Json -InputObject @($results) -Compress";
      const pending = promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout: 30_000 },
      );
      pending.child.stdin?.end();
      const { stdout } = await pending;
      expect(JSON.parse(stdout)).toEqual(
        [directory, file].map(() => ({
          protected: true,
          ownerMatches: true,
          ruleCount: 1,
          currentIdentityOnly: true,
          fullControl: true,
        })),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
