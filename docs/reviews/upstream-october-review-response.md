# October catch-up review response

The complete available October implementation and its subsequent review fixes are
now included on `fix/upstream-october-review`, based on
main `9355a57a59`. They were integrated from `f5/upstream-october-2026` at
`01c0497143`. Review the actual submitted changes with:

```sh
git diff 9355a57a5958b88bfcf639c071222c16b43d57e6
```

All 17 main commits since the October branch's last merge are retained. The
integration preserves main's atomic checkpoint-ref deletion, storage cleanup's
cancellation and directory-replacement checks, and its MCP/storage contracts.
The bundled protocol version is 29, after main's version 28. No history was
rewritten: the recommendation to rebase conflicts with AGENTS.md's explicit
prohibition, so integration used a squash merge onto a new branch from main.

Additional regressions exercise auto-pull and completed worktree setup against
real checkouts with over 1 MB of expanded ignored dependency paths. They share
the same fixture as the cleanup regression. Audit previews now include the total
path count as well as their existing 32-entry/4 KiB bound. The cancellation result
also carries the common ignored-path result field, retaining the newer cleanup
checks without breaking audit consumers.

The findings are accepted. The only procedural departure is preserving history
instead of rebasing. This patch does not claim the full catch-up or its mandatory
cut line is complete; the unresolved obligations below still apply.

## Continued implementation after the full-plan request

The integrated baseline is committed as `aaff303849`. The shared checkout was
subsequently saved by the user as `f46c26cd2c` and switched to main; continuation
now uses the isolated `f5-upstream-october-review` worktree. Subsequent implementation
adds the following behavior, with delivery decisions still requiring per-SHA proof:

- Legacy global and per-instance OpenCode passwords move to `ServerSecretStore`.
  Removed instances also remove their stored passwords. An explicit replacement
  repairs a missing secret; unrelated changes still fail closed.
  Migration and ordinary writes share rollback, preserve symlinks, and fail closed
  when a stored reference cannot be read. Collector headers use the same path and
  are removed from client reads. Failed migration preserves the original document.
- OTLP traces and metrics use the installed Effect JSON/protobuf serializers.
  Endpoint/header precedence, signal kill switches and resource attributes are
  resolved centrally. The trace exporter bounds retained bytes and records,
  owns one HTTP request, rejects redirects and aborts on shutdown. Metrics export
  serially with bounded bodies and request deadlines. Unavailable log directories
  do not prevent server work. The General settings Diagnostics card exposes
  collector URLs, secret header editing and credential-free source information.
- Event-loop stalls become independent duration-bearing spans with a 128-entry
  recent history. SQLite spans identify connection role and semaphore wait time.
  Standalone queries now reserve the connection until their operation scope closes;
  a failing-before test shows a transaction entering a suspended statement before
  this change, and verifies both serialization and the visible query result. Explicit SIGUSR2
  requests write heap snapshots, and `f5 trace summarize --file ...` streams a
  bounded trace reader and reports slow spans, failures and stalls.
- Captured GitHub API requests use bounded HTTP reads instead of `gh api`.
  Conditional caching, scheduling, credential scope and generation checks remain.
  A rejected token refreshes once, and retries cannot change the account. A
  failing-before race test also proves that a retry uses the exact token whose
  identity was verified, even if token resolution changes during refresh. The
  legacy CLI token fallback has tested five-minute/ten-second positive/negative TTLs.
  PR listing/viewing/creation, reviews, comments, ready state, reviewer changes,
  guarded merge/branch update, repository metadata, teams and search now use the
  captured HTTP path. PR Hub diff reads request bounded text through the same
  boundary. Concurrent head lookups batch up to 50 per repository/account/priority,
  and the five-second shared remote-routing cache avoids Git work for repeated
  reads. The remaining 15g verify-first scenarios, merge-read policy and sync
  reset-wait behavior are still obligations.
- Desktop login-shell hydration imports missing CA trust variables without
  replacing inherited values. A packaged boot entry enables the V8 compile cache
  before main and preloads it inside the isolated backend. Development and
  AppImage paths retain their existing policy; Node's opt-out is respected.
  Settings → About installs explicit `f5`/`t3` symlinks to a launcher using the
  bundled runtime. It preserves foreign and dangling destinations, serializes
  installs, falls back without privilege escalation and refuses PATH shadowing.
- Provider initialization diagnostics and unavailable snapshots now contain fixed
  failure categories instead of schema payloads or raw driver errors. Two
  failing-before tests reproduce credential leaks through both paths.
- Panel tabs can be dragged, searched with Mod+T and reopened with Mod+Shift+T.
  All explicit close actions share a bounded 20-tab history per thread, retaining
  file positions. Removing a thread clears it; hiding a panel adds no history.
  Conversation width also offers Full while preserving existing preferences.
  Unbound effort-up/down commands use reported model levels and the existing
  Codex fallback policy, retain other traits and ignore repeated keydown events.
  A full-app Chromium case verifies the custom bindings without sending a turn.
- Settled Mermaid fences load 11.17.x only when visible, serialize global renderer
  configuration, bound the pending queue/source/output/cache, and follow light/dark
  themes. SVGs display as images rather than application DOM. Source toggling and
  failure fallback stay in place. Shell fences use the existing terminal command
  runner on an explicit click, with a fresh terminal in the thread workspace.
  Streaming/unfinished fences, non-shell languages and invisible controls have no
  run action; external-bot rendering retains its restricted policy.

Focused fake-collector, secret persistence/recovery, HTTP credential, browser
settings, real child-process cache, CLI and desktop isolation checks cover these
changes. The Node-built CLI successfully summarized a fixture without starting
the server. Both server and desktop builds succeed. Later validation results
supersede the earlier handoff below.

The full plan is not delivered yet. Settlement, thread HTML tools/MCP apps,
PR watches/guides and remaining PR UX, project provider/custom ACP/Pi,
scratch projects/prompt links, timeline/panel/usage/native history changes,
desktop passkeys, full verify-first triage and remaining performance
comparisons are still required. No unfinished workstream has been promoted.

## Current validation (2026-10-19)

- `bun fmt`, `bun lint`, `bun typecheck` (all eight packages),
  `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check` and whitespace checks pass.
- Five focused Git/cleanup suites pass 65 tests, including both new consumer
  regressions. The final audit-summary change passes all 24 cleanup tests again.
- The exhaustive real-Git matrix passes 162 tests; Git smoke passes eight;
  server integration passes 25, with 18 existing opt-in skips.
- The earlier continuation server unit run passes 4,787 tests and fails three launcher process-identity
  cases because this host rejects `/bin/ps` with `EPERM` (12 existing skips).
- Desktop unit tests pass all 567 cases after the installer/cache changes. The Chromium cross-frame snapshot smoke
  passes. Native Electron 40.6.0 aborts with `SIGABRT` before a result, so native
  integration remains unverified.
- A fresh 40 MiB WAL measurement passes five warmups and thirty measured
  repetitions. The largest event-loop p99 is **1.446911 ms**, below 50 ms. The
  [raw report](./upstream-october-checkpoint-measurement.json) retains every
  sample, runtime/hardware details and fixture/harness/lockfile digests. It
  explicitly records the uncommitted source (`sourceDirty: true`), and makes no
  comparative CPU or whole-application performance claim.
- `bun run test:full` was executed and fails the same two scripts migration
  recovery identity cases: 330 tests pass, two fail. It stops before the
  exhaustive matrix; that matrix was run independently above. Recovery remains
  conservative when process identity cannot be verified. No assertion, identity
  protection or required gate was skipped or weakened.

The full gate is failed. Verify-first triage and the remaining security/native
verification obligations are unfinished. These results do not establish the
mandatory catch-up cut line.

The subsequent HTTP/SQL/panel continuation passes 589 Git/PR Hub/source-control
checks, 18 focused SQLite checks, 72 panel/shortcut checks, 138 appearance/settings
checks, nine installer/About browser checks and four panel browser checks. The
updated exhaustive Git matrix passes all 162 cases. Its fake adapter now honors
`state: "all"` and normalizes API states, preserving the existing closed/merged/
fork/open-preference assertions. The real desktop launcher starts Electron in
Node mode and successfully prints the bundled server's `--help`. Full native GUI
snapshot verification remains separate and unverified.

The complete server run after the SQL reservation correction passes 4,808 tests
and fails six (12 existing skips). Three are the launcher identity checks; three
are workflow-storage assertions affected by concurrent workflow-archive edits
in this checkout. Those edits are preserved and outside this continuation.
Subsequent focused privacy/settings/registry checks pass 38 cases, and the latest
HTTP/token race suite passes 66. Chromium tab dragging passes with no unhandled
errors, as do the searchable tab menu and panel boundary checks.

A fresh checkpoint measurement after the SQL reservation correction again runs
five warmups and thirty measured repetitions. Maximum event-loop p99 is
**3.219455 ms**, below 50 ms. The [new raw report](./upstream-october-checkpoint-postscope-measurement.json)
retains source-dirty, runtime, hardware and digest metadata. Earlier reports are
preserved; none is a comparative CPU or whole-application performance claim.

## Earlier implementation and review evidence

The empty supplied patch did not contain this branch. Author A's statement that
there was no implementation applies to that patch, rather than this worktree.
The completion gap is valid: the full catch-up and its mandatory cut line are
still incomplete. Coverage accounting is not delivery credit.

`4d4e868562` also merges the subsequent main head `9539f4b18b`; no main commits
are missing at this verification point. It includes main's regression for a
directory rename with unchanged timestamps. Its directory-entry signature is
retained. The merged watcher suite passes all 17 cases in isolation, but the
complete server run still misses a directory notification (4,679 passed, four
failed, including the three launcher identity cases). A deterministic silent
watcher regression independently fails before reconciliation. One shared timer
now rechecks registered paths at the existing two-second poll interval, skipping
failed/missing watches that already poll, in-flight checks and pending debounces.
It reads signatures without file contents and stops when the registry is empty.
The new regression also checks later renames and release ownership.

## Changes following review

| Finding                                                  | Resolution and evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ignored dependency paths overflow the status buffer      | `a54bdf0bab` separates status from two ignored scans. Ordinary ignored directories remain collapsed. A bounded pathspec scan finds `.env` and `.env.*` segments inside ignored trees. Both scans propagate truncation and errors block removal. A real fixture produces over 1 MiB of ignored paths, retains its nested credential, then becomes removable after that credential is removed.                 |
| Ignored-path audit strings are unbounded                 | Path previews are limited to 32 entries and 4 KiB of UTF-8 labels, with an omission count and escaped control characters. A Unicode regression checks the byte bound.                                                                                                                                                                                                                                        |
| Manual removal inherited the automatic cleanup exception | Only automatic cleanup selects the environment-only policy. Manual, maintenance, legacy and rollback removal retain the original dependency-directory exception. Real tests preserve a database, `.envrc` and a private key through both the orchestration gate and direct GitCore removal.                                                                                                                  |
| Branch is behind main                                    | `12fd563d5d` merges `97df84626a`, preserving both histories. Rebase was not used because AGENTS.md prohibits history rewriting. Workspace transitions and recovery fingerprints are retained. Protocol 26 follows main's released 25; migration 120 is next.                                                                                                                                                 |
| Writer read transactions reserve the write lock          | `66e146d8b8` adds `withReadTransaction`, which reserves the existing connection and starts deferred BEGIN. Nested read snapshots remain consistent while another connection writes. Write transactions use BEGIN IMMEDIATE in Node and Bun.                                                                                                                                                                  |
| Missing separate-process BEGIN IMMEDIATE coverage        | Four integration cases exercise ordinary writes and read-then-write transactions in separate Node and Bun processes. The transaction's first read observes the committed competing write, rather than an earlier snapshot.                                                                                                                                                                                   |
| Missing exclusive-lock preparation recovery              | The same prepared query succeeds on positional and row paths immediately after an exclusive database lock is released. The production 5,000 ms busy timeout remains independently tested.                                                                                                                                                                                                                    |
| Missing 40 MiB checkpoint latency coverage               | The dedicated performance command uses five warmups and thirty measured repetitions with runtime/hardware/fixture metadata. The initial largest event-loop p99 was 1.715 ms. After the idle-checkpoint correction, a fresh five-warmup/thirty-repetition run measured a maximum of 1.750015 ms, below the 50 ms requirement. This is not a comparative CPU or whole-suite performance claim.                 |
| Checkpoint contention gauge has false positives          | The worker reports contention only after an incomplete PASSIVE attempt, not merely an uncheckpointed NOOP result. Its description includes reader or writer contention. A deterministic worker-source test covers backlog, incomplete checkpoint and recovery.                                                                                                                                               |
| Short passwords corrupt snapshot metadata                | `414eb21d48` uses word boundaries for credentials shorter than four characters. Existing field names and unrelated words remain readable; exact credentials remain masked. Serialized variants and a bounded matcher count are covered.                                                                                                                                                                      |
| Worktree add lacks an option terminator                  | `a54bdf0bab` adds `--` before the path and base ref. Unit argument checks and the real-Git matrix pass.                                                                                                                                                                                                                                                                                                      |
| Missing user MCP credential argument test                | `414eb21d48` also fixes the underlying SDK behavior: header/env-bearing configs travel over its existing control channel, before any prompt is admitted. The real installed SDK transport test inspects actual process arguments and the control request. Failure, cancellation and timeout close the owned query without exposing configuration errors. Every startup and recovery creation uses this path. |
| Trace integration test assumes a 25 ms filesystem write  | The test now waits on the real sink's flush barrier, preserving its span-name and attribute assertions. All 52 engine/observability cases pass together.                                                                                                                                                                                                                                                     |
| Unresolved yaml imports                                  | The scripts workspace already declares yaml. Frozen dependency installation resolves the imports; all eight typecheck packages pass. No manifest workaround was needed.                                                                                                                                                                                                                                      |

Settings/logging verification now includes three failing-before reproductions for
malformed credential values in disk decode logs and disk/memory normalization
errors. The fix reports only known top-level settings fields, bounds traversal,
and never formats raw values or dynamic record keys. The write guard and original
invalid file remain intact. A second failing-before reproduction found development
URL credentials in startup records and browser failure hints; those now show only
the origin. The browser receives the unchanged private URL. The launch-token
failed-opener scenario already passed and is retained as equivalence evidence.
All 60 settings/diagnostic/startup cases and the existing WebSocket settings-read
redaction case pass.

The verify-first settings item #15009 also has a failing-before reproduction:
atomic saving replaced the settings symlink, and edits to a destination outside
the profile were missed. Settings and keybindings now opt into linked atomic
writes; other asset writers retain their existing policy. The destination is
canonicalized and checked again before publication. Tests preserve relative and
dangling chains, reject cycles and target substitution, follow repointed links,
and retain an external keybinding edit immediately after an app write.

The shared settings watcher attaches before startup returns and owns a one-entry
invalidation queue. A deterministic test covers coalesced remove/create events.
Native probes also reproduced entirely missing notifications for a first atomic
save, so an owned 500 ms metadata check provides a fallback, with one check in
flight and no unchanged-file reads. All 68 focused settings/keybinding/writer/
watcher cases pass. These checks do not claim a race-free filesystem rename;
Node has no portable directory-fd-relative rename API, so a directory substitution
after the last canonical-path check remains a filesystem race.

The larger server run exposed a checkpoint-worker race as well. A failing-before
VM reproduction shows that a busy NOOP result of `-1/-1` incorrectly cleared a
prior contention state. Unknown progress now retains that state, and incomplete
or busy checkpoints schedule another owned idle check. The pinned-reader test
now releases its reader without issuing another writer query; the worker must
catch up by itself. All 23 SQLite correctness/integration cases pass. The updated
40 MiB measurement is `/tmp/f5-october-checkpoint-measurement-2.json`, with five
warmups and thirty repetitions, a maximum event-loop p99 of 1.750015 ms, and
source-dirty/runtime/hardware/digest metadata retained in the report.

The subsequent Git audit also found missing explicit-bare discovery protection
and Windows long-path configuration. Both process paths now install these while
preserving inherited configuration and credentials. Worktree recovery rejects
option-shaped refs as creation does. Two real-Git failing-before tests found that
an option-shaped expected SHA could bypass conditional branch deletion, and that
deleting a symbolic branch could delete its target. Full SHA validation, an
option terminator and `--no-deref` fix those cases. See the
[Git security verification](./upstream-october-git-security.md) for source scope,
platform limits and scenarios.

## Remaining obligations

The ledger contains all 4,084 coverage records, including the 1,752 October
entries. October classification tests and the September overlay/carrier tests
exist. The 299 carrier members and 26 settlement overrides are preserved, but
their accepted behavior is not yet fully reconciled. Verify-first triage across
15a, 15r, 15t and 15u and the broader feature work remain outstanding.

The security cut line is also incomplete. Cross-frame preview redaction is now
implemented and passes the Chromium smoke and 34 focused tests; native Electron
launches abort with SIGABRT before producing a test result. See
[the snapshot verification record](./upstream-october-preview-snapshot.md).
#20446 remains deferred. Native Electron verification is still failed, and
the legacy OpenCode password migration described in the continuation above now
passes its persistence/recovery tests. These do not establish native Electron
snapshot verification. Settings/logging proof above is separate
from the preview tests.

## Validation

Formatting, lint, all eight typecheck packages, the upstream ledger gate and
`git diff --check` pass. The current exhaustive Git matrix passes 161 cases and
the smoke matrix passes eight. The focused Git/process suites pass 68 cases;
the three test-helper cases also pass after updating their explicit-bare argument
expectations. Focused
SQLite correctness/integration tests pass 23 cases; Claude adapter/private MCP
transport tests pass 287; preview snapshot tests pass 34, and all 558 desktop
unit tests pass.

`bun run test:full` was executed and still stops at two migration-recovery
creation-identity failures. Running the remaining workspaces independently also
finds the three existing standalone-launcher identity failures: this host rejects
`ps`/`/bin/ps` with EPERM. An additional asynchronous trace-test failure was
corrected with the flush barrier above. No identity check, assertion or timeout
was weakened. The full gate remains failed; these results are not a waiver.

A later complete server run passed 4,667 tests and failed five: the three launcher
identity cases, an unchanged workspace-directory watcher notification, and the
pinned-reader race described above. The SQLite correction passes its focused
suite, and the linked settings tests pass in that full run. The workspace watcher
failure remains recorded and has not been waived or hidden by a focused rerun.

The next server run, after the Git audit, passed 4,676 cases and failed six:
the same three launcher identity cases, the workspace watcher notification and
two helper expectations that still assumed implicit bare discovery. Those two
expectations now require explicit `--git-dir=.` selection and pass their focused
suite. The October/September classification tests pass in the scripts run;
that complete workspace still fails the two creation-identity recovery cases
(330 passed, two failed). The full repository gate was run again and remains
failed. No assertion was removed and no timeout was increased.

After merging main and retaining the missed-notification reconciliation,
the complete server unit run passes 4,681 cases and fails only the three
launcher identity cases (12 existing skips). All 18 workspace watcher cases
pass in that run. The server integration suite passes 25 cases, with 18
opt-in cases skipped; its Git smoke prerequisite passes eight. The exhaustive
Git suite passes 161 separately. The final `bun run test:full` still fails the
two scripts recovery cases above and does not reach its exhaustive Git stage.
Formatting, lint, all eight typecheck packages, the required-upstream ledger
gate and diff whitespace checks pass on the merged branch. The original
checkout remains untouched.

The isolated continuation passes 12 Markdown/terminal/Mermaid Chromium cases and
both shell source unit cases. Its production web build passes the initial-JS
budget at 1,495,371 bytes (40.5% below the fixed baseline); this is a bundle-size
check, not an interactive performance comparison. A new `env -i` full-gate run
again passes 330 scripts tests and fails the two process-identity recovery cases
before the exhaustive matrix. The host still denies `/bin/ps` with EPERM.
