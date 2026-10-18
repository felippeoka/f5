# MCP servers

MCP settings store server definitions in a common scope and a project scope. An exact-name project entry overrides the whole common entry. In project settings, **Use in this project** opts out of an inherited common server without changing other projects. **Override** opens a project draft using the common definition. Each scope accepts 16 servers.

**Import configuration** opens a preview for pasted F5/Claude JSON, Codex JSON, or Codex TOML. **Detected → Detect configurations** explicitly reads the selected account's Claude state (including project entries), the project's `.mcp.json`, and Codex's `config.toml`. Files must be regular files of at most 1 MiB. Detection never applies configuration. Choose entries, review warnings, and explicitly choose **Replace** for any conflict; existing entries are kept by default. A version conflict refreshes the preview without discarding your text or choices, and requires confirmation again.

**Test** checks either the saved server or the editor draft. A stdio test executes the configured command with the selected account's environment and the draft's environment overrides. Remote tests use the configured headers and bearer environment variable. Tests initialize the connection and list advertised tools, resources, and prompts; they never invoke tools or fetch resource contents. Tests have a 60-second deadline and clean up their child processes. Results show latency, server information, bounded tool summaries, and sanitized errors and stderr. Sign-in requirements remain owned by the provider; a test does not start OAuth.

The inspector's **Tools** tab lets you disable individual tools. Switches change the disabled-tools list. A non-empty enabled-tools list still restricts availability and cannot be broadened by a switch; edit that list under Advanced. Live tool data is preferred, with the last connection test as a fallback. Saving does not prove that a running conversation has applied the configuration. Apply to all live sessions to reconcile immediately, or let sessions pick up the saved version at their next message. Readiness and the applied configuration version are separate observations.

## Stored secrets

Environment and header values can be marked **Secret**, then stored explicitly. F5 replaces each value with a whole-value `${f5-secret:<uuid>}` reference. Replacing a secret creates a new UUID. Stored values are masked in the editor and omitted from MCP JSON exports. Imports reject these references because they cannot transfer the underlying secret.

Secrets live in permission-restricted files in the profile's secrets directory (directory mode 0700, file mode 0600). The backup system includes that directory only when you explicitly choose password-encrypted secret backups. These files are not a full credential vault and are not encrypted at rest. Existing plaintext values stay unchanged until you store them as secrets.

Resolved values still reach providers through their process arguments and may be visible to software with access to those processes. Mapping Codex header secrets to `env_http_headers` remains a follow-up. Diagnostics and test results scrub configured values of at least eight characters and credential-like fields, and remove URL credentials, queries, and fragments; transformed secrets cannot be guaranteed to be caught.

If a referenced secret is missing, F5 skips that server, reports a warning, and continues the session with other servers. Replace the missing value in settings. Startup cleanup removes only unreferenced MCP secrets older than 24 hours; saving never deletes secrets.

Opt-outs compare names without case and remain recorded when a common server is removed. Reusing that name keeps the project opted out; explicitly enable it in that project if desired.

Secret masking prevents accidental display and export of values; it is not access control against an authenticated F5 client. Clients can use stored references in unsaved probes and provider configuration, including commands or endpoints they control. Only connect clients you trust with the profile's credentials. MCP secret storage is bounded to 4,096 files (at most 64 MiB of values), including unsaved writes; startup collection frees unreferenced entries older than 24 hours.
