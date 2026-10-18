# Threads and workspaces

A thread is one conversation with one agent in one workspace. The agent edits files in the
workspace you choose, and F5 records its commands, file changes and plans so you can inspect them
afterwards.

![Chat thread with commands, file changes and the diff panel open on a new Postgres adapter](../../assets/screenshots/thread.png)

## How to

1. Click **New thread** (`mod+N`) or type in the box on Home.
2. Pick the **provider and model** from the model chip, and **traits** such as reasoning effort.
3. Pick **Access**, the thread's [runtime mode](../runtime-modes.md).
4. Choose **Agent** or **Plan**. Plan asks for a plan you can accept or revise before any change.
5. Choose the **workspace**: **Local** (the project checkout) or a
   [worktree](worktrees-and-storage-automation.md) with its own branch and directory.
6. Send your message.

The composer also takes [attachments](attachments-and-media.md), `@` file mentions and `/`
commands, including provider and project skills. The context ring shows how full the model's
context window is.

## While the agent works

In Supervised and Auto-accept edits modes the agent stops for approval, and its questions wait for
your answer. Where the provider supports it, a message sent mid-turn can steer the turn instead of
waiting (**Settings → Threads → Follow-up behavior**). **Stop generation** ends the turn.

Queued messages appear above the composer. You can pause the queue, reorder it, run one now, edit,
duplicate or cancel it. The queue is stored on the server, so it survives restarts.

## Panels

The right side of a thread holds the **Agents**, **Diff**, **Plan**, **Files** and **Preview**
panels; open them from the panel picker or their shortcuts. The terminal (`mod+J`) opens below the
thread in the workspace directory, and project scripts run from the thread header.

The Files panel can edit files. If a file changes on disk while you have unsaved edits, F5 marks a
conflict and keeps your draft. **Open in editor** hands the file to your external editor.

## Review changes and rewind

Each turn lists its changed files with line counts, and **View diff** opens the Diff panel for that
turn. F5 records a checkpoint after each turn; on providers that support it, you can revert the
thread to an earlier message, which restores the files. Stop the agent before reverting.

## Git

Threads show their branch. From the thread header you can create branches, open worktrees and run
commit, push and pull request actions. Linked pull requests also appear in the
[Pull Requests hub](pr-hub-forges.md).

## Good to know

> [!NOTE]
> **Thread summaries** (**Settings → Threads**) send thread messages, activities, plans, tasks and
> checkpoints to the account you choose, including threads that ran on other providers.

- **Home** groups threads into Pinned, Needs you, Working and Recent. `mod+K` searches threads,
  workflows and commands.
- Archive a thread from its sidebar menu; archived items are under **Settings → Archive**.
- A usage-limit notice can be snoozed until a time you pick; snoozed threads show a moon icon.
- A turn running during a restart resumes only if **Settings → Threads → Resume active turns after
  restart** is on (off by default).

<details>
<summary>Panels in detail</summary>

| Panel   | What it shows                                                                   |
| ------- | ------------------------------------------------------------------------------- |
| Agents  | Subagents and background workflows started from the thread                      |
| Diff    | Files the thread changed, per turn or for a recorded file change                |
| Plan    | The current implementation plan                                                 |
| Files   | The workspace file tree and a file viewer with editing                          |
| Preview | The built-in browser, in desktop builds ([preview browser](preview-browser.md)) |

New threads default to **Full access**; change the default under **Settings → Threads → Default
permissions** or per project. Resumed turns show "Resuming after restart", and projects can
override the resume setting.

</details>

## Related

- [Getting started](getting-started.md)
- [Agent tools](agent-tools.md)
- [Workflows](workflows.md)
- [Keybindings](../../KEYBINDINGS.md)
