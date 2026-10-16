# Worktrees, fan-out and storage automation

## Worktree setup progress

The first message of a new worktree thread is sent at once. F5 creates the thread, queues the
message and prepares the worktree in the background, showing a setup card above the composer with
each stage: fetching the base branch, checking out files (with a percentage), initializing
submodules, running the project setup script and starting the agent. The last few lines of the
setup script's output are shown while it runs.

The queued message waits for the worktree. It is delivered when the checkout is ready, or when the
setup script finishes if the script is marked **Agent waits for this script** in the project
scripts menu. Other setup scripts keep running alongside the agent.

From the card you can:

- **Cancel** while setup runs. A worktree and branch that F5 created are removed only if nothing was
  written to them and no other thread, terminal or session uses them; otherwise they are kept and
  the card says so. The message stays queued and paused.
- **Retry** after a failure, for example once a missing base branch exists.
- **Work locally** to send the paused message in the project root instead.
- **Discard** a cancelled or failed setup. The empty thread is deleted and your message is restored
  as a new draft.

If F5 restarts during setup, the setup is shown as failed and its queue is paused. Nothing is
removed; use Retry or Work locally.

## Sending one message to several models

In a new thread's model picker, Shift+click (or Shift+Enter) adds up to six models. The picker shows
how many are selected, and a plain click goes back to one model. Sending creates one thread per
model, each with its own worktree and branch, three at a time. Attachments are copied to each
thread. If some threads cannot start, the others continue and the draft is kept so you can retry
the failed ones.

## Automatic storage cleanup

Settings → Storage → **Automatic cleanup** is off by default. When on, F5 checks hourly, at
startup, after a thread is deleted and when these settings change. It can remove:

- **Idle worktrees** that F5 created for this profile, when any enabled rule matches: idle for a
  number of days since the thread's last message, the thread's pull request was merged and its
  commits are in the default branch, the thread was deleted, or the branch has no commits beyond the
  default branch.
- **Provider logs** older than a number of days. The live event log is never removed.

A worktree is never removed when it has uncommitted or untracked changes, ignored files other than
`node_modules/` (for example `.env`), a detached HEAD, an open terminal or agent session, queued
turns, or another thread using it. Each check is repeated right before removal, and removal never
forces. The branch is always kept and the thread keeps its worktree path, so the next message
recreates the worktree. Worktrees outside this profile's worktrees directory, and any directory
containing a project root, are ignored.

**Preview what would run** lists every match with the action F5 would take or the exact reason it
would skip. **Recent activity** shows what ran, kept for 90 days. Entries name worktrees relative
to the worktrees directory.

**Keep preview screenshots and recordings for** sets how long the desktop app keeps preview
artifacts. Empty keeps the 7-day default. Profiles share one artifact folder, so the longest
retention any profile sets applies.

## Auto-pull default branches

**Auto-pull default branches** (Settings → Storage, off by default) fast-forwards a project root
every 15 minutes when it has the default branch checked out with an upstream, a clean tree with no
untracked files, no merge, rebase, cherry-pick, revert or bisect in progress, no local commits the
upstream lacks, and no agent session working in it. It runs `git pull --ff-only` and never merges
or rebases. When another F5 profile is updating the same repository, the cycle is skipped. Pulls
appear in Recent activity and in the preview.

## Project overrides

**Automatic worktree cleanup** (use the global rules, off, or custom rules) and **Auto-pull the
default branch** can be set per project in Settings → Global › Project. A checked-in `f5.json`
cannot set either one: automation that removes worktrees or pulls branches is always your choice.

## Backups

Settings → Storage → **Export backup** creates a consistent SQLite snapshot,
checks its integrity, and archives settings, snapshot-owned attachments and older
unregistered attachment files in a
separate maintenance process. You can keep using F5 while it runs. Attachment
cleanup waits until the snapshot’s files have been copied; ordinary thread writes
do not take that retention lease. Cancelling export terminates the helper before
staging files and the lease are released. Profile credentials stay excluded from
manual backups unless you choose encrypted credential export and supply a password.

**Daily backups** is off by default and independent of automatic cleanup. While
F5 is open it checks hourly, starting one minute after launch, and exports when
there is no successful scheduled backup in the preceding 24 hours. It keeps the
seven newest successful scheduled archives in `<profile state>/backups`; manual
archives and failed exports do not count against retention. Scheduled backups
always exclude credentials. F5 does not store an encryption password for them.
A failed export preserves the previous successful backups and retries at the next
hourly check. Backups can be validated and restored through the existing Restore
control; restoration takes effect on restart.

Restoring into a different state directory rebinds attachment registry and cleanup
paths to that directory while retaining ownership and content hashes. Restored
archives can be exported again without relying on files in the source profile.

Daily backup status shows the last attempt, last success and any failure in Storage
settings. Missing owned attachment errors identify the attachment and path. Known
owned files that are missing are not silently omitted. Old restored registry paths
are rebound only in the exported snapshot; the live database is unchanged.
Credential-free exports redact OpenCode passwords and sensitive provider environment
values from settings. When credential export is explicitly selected, settings and
secret files are encrypted with the supplied password. Old interrupted daily partial
files are removed before the next scheduled check.
