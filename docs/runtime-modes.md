# Runtime modes

A runtime mode is a thread's permission posture: what the agent may do without asking. You choose it per thread from the access chip in the composer. New threads default to **Full access**; change the default under **Settings → Threads → Default permissions**, or override it per project in [project settings](./user/project-settings.md).

| Mode              | What it does                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Supervised        | Ask before edits and commands.                                                                      |
| Auto-accept edits | Auto-approve edits, ask before other actions.                                                       |
| Auto              | The provider's AI reviewer decides approvals, not F5; it can approve risky commands without asking. |
| Full access       | Allow commands and edits without prompts.                                                           |

## Provider support

| Provider    | Supervised | Auto-accept edits | Auto | Full access |
| ----------- | :--------: | :---------------: | :--: | :---------: |
| Codex       |    Yes     |        Yes        | Yes  |     Yes     |
| Claude Code |    Yes     |        Yes        | Yes  |     Yes     |
| OpenCode    |    Yes     |        Yes        |  No  |     Yes     |
| Cursor      |    Yes     |        No         |  No  |     Yes     |
| Grok        |    Yes     |        No         |  No  |     Yes     |
| Antigravity |    Yes     |        No         |  No  |     Yes     |
| Muse Code   |     No     |        Yes        |  No  |     Yes     |

Muse Code approves in-workspace edits in every mode, so F5 never offers Supervised for it. See [Muse Code](./providers/muse.md).

## How modes map to providers

Codex (`approvalPolicy` and `sandbox` on the app-server session):

| Mode              | Codex settings                                                          |
| ----------------- | ----------------------------------------------------------------------- |
| Supervised        | `untrusted` + `read-only`                                               |
| Auto-accept edits | `on-request` + `workspace-write`                                        |
| Auto              | `on-request` + `workspace-write`, with `approvalsReviewer: auto_review` |
| Full access       | `never` + `danger-full-access`                                          |

Claude Code (`permissionMode`): Supervised is `default`, Auto-accept edits is `acceptEdits`, Full access is `bypassPermissions`, and Auto is `auto`. Auto is used only when the model and CLI support it; otherwise the session falls back to `default` and F5 asks before actions.

The chosen mode is persisted alongside the thread/session so reconnects and resumes keep the same posture. See [provider-architecture.md](./provider-architecture.md) for how the shared adapter contract surfaces this.
