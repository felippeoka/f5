# October catch-up review response

The complete available October implementation and its subsequent review fixes are
now included in the working-tree patch on `fix/upstream-october-review`, based on
main `9355a57a59`. They were integrated from `f5/upstream-october-2026` at
`01c0497143`. Review the actual submitted changes with:

```sh
git diff HEAD
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

## Current validation (2026-10-19)

- `bun fmt`, `bun lint`, `bun typecheck` (all eight packages),
  `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check` and whitespace checks pass.
- Five focused Git/cleanup suites pass 65 tests, including both new consumer
  regressions. The final audit-summary change passes all 24 cleanup tests again.
- The exhaustive real-Git matrix passes 162 tests; Git smoke passes eight;
  server integration passes 25, with 18 existing opt-in skips.
- The server unit run passes 4,765 tests and fails three launcher process-identity
  cases because this host rejects `/bin/ps` with `EPERM` (12 existing skips).
- Desktop unit tests pass all 558 cases. The Chromium cross-frame snapshot smoke
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
upstream's migration of legacy OpenCode passwords into the secret store has not
yet been ported. Client reads redact those passwords, but the existing legacy
settings file still stores them inline. Settings/logging proof above is separate
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
