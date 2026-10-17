# Provider prerequisites

F5 needs at least one authenticated provider on the machine running the F5 server.

## Codex

- Install the [Codex CLI](https://github.com/openai/codex) so `codex` is on your PATH.
- Authenticate it once before running F5, for example:

  ```bash
  codex login
  ```

  Either ChatGPT auth or an API key works — use whichever your Codex install supports.

- F5 starts the provider process via `codex app-server` per session. If `codex` is missing or unauthenticated, session startup will fail with a clear error.

## Claude Code

- F5 runs the Claude executable bundled with the Claude Agent SDK by default; a separate global
  `claude` command is not required for sessions or health checks.
- Authenticate Claude once before running F5. You can use a separately installed
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI for the login:

  ```bash
  claude auth login
  ```

- F5 launches Claude sessions through the Claude Agent SDK, which discovers credentials from the standard Claude Code install locations.

## Antigravity

Enable Antigravity in Settings, explicitly install its pinned runtime, then sign in with Google.
See [Antigravity setup and isolation](providers/antigravity.md). It is disabled by default.

## Muse Code

This is Meta's Muse Code coding CLI, not the Muse personal agent (which has no public API yet;
F5 does not imitate it).

- Install the CLI yourself so `muse` is on your PATH. F5 never runs the installer:

  ```bash
  curl -fsSL https://dev.meta.ai/install.sh | bash
  ```

- Sign in once: run `muse` in a terminal, use `muse auth set`, or set `META_API_KEY` in the
  provider instance's environment. A set `META_API_KEY` takes precedence over a stored browser
  sign-in.
- Muse Code is unavailable in isolated (non-default) profiles. See
  [Muse Code](providers/muse.md).

## Cursor

Cursor is Early Access.

- Install the Cursor CLI so `agent` is on your PATH. F5 runs it as `agent acp`.
- Sign in once with `agent login`.
- If `agent` is missing, set **Binary path** on the instance in **Settings → Providers**. If the
  status card says Cursor Agent is not authenticated, run `agent login` again.

## OpenCode

OpenCode can run locally or against a server you already operate.

- **Local:** install OpenCode so `opencode` is on your PATH; F5 starts `opencode serve` when a
  session needs it. Configure models and credentials with OpenCode's own provider setup.
- **External server:** set **Server URL** on the instance in **Settings → Providers**, and
  **Server password** if the server needs one. The password is stored in plain text on disk. No
  local `opencode` binary is needed in this mode.
- If `opencode` is missing, F5 reports that it is not installed or not on PATH. On macOS, a
  quarantined download is blocked; fix it with `xattr -d com.apple.quarantine $(which opencode)`.

## Grok

Grok is Early Access.

- Install the Grok CLI so `grok` is on your PATH. F5 talks to it over ACP.
- Sign in once with `grok login`.
- If the status card says Grok is not logged in, run `grok login` in a terminal; if `grok` is not
  found, set **Binary path** on the instance.

## Windows executable overrides

F5 launches provider arguments without a command shell so workspace paths and provider options are
not reinterpreted by `cmd.exe`. Native `.exe`/`.com` executables, JavaScript CLI entry points, and
standard npm Node `.cmd` shims are supported. Arbitrary `.bat`, `.ps1`, and non-Node `.cmd` wrappers
are deliberately rejected; configure the wrapped executable or JavaScript entry point instead.

Custom Claude binary paths are stricter because the Agent SDK uses a direct process launch: use a
directly runnable executable or the Claude CLI JavaScript entry point, not a `.cmd`/`.bat` shim.

## Picking a provider at runtime

Provider and model are picked per thread from the composer's model picker. Switching providers
doesn't require restarting the F5 server. F5 starts a fresh provider session on demand when the
selected provider runtime is available and authenticated.

## Instances and profiles

You can add several instances of one provider in **Settings → Providers**, for example two Codex
accounts with different homes. Instances share the profile they run in. Isolated F5
[profiles](profiles.md) support only managed Codex and the bundled Claude runtime; other providers
run in the default profile.
