# F5 documentation

## Getting started

- [Install F5](install.md): desktop downloads, upgrades and updates.
- [Provider prerequisites](provider-prerequisites.md): install and sign in to each provider.
- [Codex](providers/codex.md), [Claude](providers/claude.md), [Antigravity](providers/antigravity.md) and [Muse Code](providers/muse.md): provider-specific details.
- [Runtime modes](runtime-modes.md): the four permission modes and which providers support them.

## Using F5

- [Workflows](user/workflows.md): Feature, Code Review, Investigation and Document runs.
- [Threads and workspaces](user/threads-and-workspaces.md): the composer, queue, panels, diffs and Git.
- [Agent tools](user/agent-tools.md): MCP servers, skills, inventories, memory and the Agents panel.
- [Attachments and media](user/attachments-and-media.md): files and images in the composer.
- [PR Hub accounts and forges](user/pr-hub-forges.md): the Pull Requests hub across forges.
- [Preview browser](user/preview-browser.md): the built-in browser, cookie import and snapshots.
- [Project settings](user/project-settings.md): per-project overrides and their precedence.
- [Standalone CLI](user/standalone-cli.md): running F5 without the desktop app.
- [Usage and limits](user/usage-limits.md): recorded activity, account limits and cost.
- [Worktrees and storage automation](user/worktrees-and-storage-automation.md): worktrees, fan-out and cleanup.
- [Profiles](profiles.md): separate F5 profiles with their own state and accounts.
- [Agent Bridge](agent-bridge.md): letting outside MCP clients work with shared projects.
- [Agent browser and computer use](agent-browser.md): how agents drive pages and, optionally, this computer.
- [Project configuration](project-configuration.md): checked-in `f5.json` defaults.
- [Environment variables](environment.md): the full environment reference.
- [Keybindings](../KEYBINDINGS.md): defaults and customization.
- [Remote access](../REMOTE.md): running F5 on another machine.

## How F5 works

- [Architecture](architecture.md): runtime, orchestration and persistence.
- [Provider architecture](provider-architecture.md): the WebSocket protocol and adapter contract.
- [Protocol versioning](protocol-versioning.md): client and server compatibility.
- [Reliability and recovery](reliability.md): restarts, retries and recovery.
- [Performance](performance.md): the performance baseline.
- [Encyclopedia](encyclopedia.md): glossary of domain terms.
- [Workspace layout](workspace-layout.md): one line per package.

## Developing and releasing

- [Quick start](quick-start.md): development and build recipes.
- [Scripts](scripts.md): repository scripts, including screenshot capture.
- [CI quality gates](ci.md): what CI checks.
- [Releasing F5](release.md): the release process.
- [Contributing](../CONTRIBUTING.md): contribution policy.
- [Security](../SECURITY.md): reporting vulnerabilities.

`reviews/`, `computer-certification/`, `profiles-review.md` and `profiles-verification.md` hold validation records, and `design/direction.md` holds design direction.
