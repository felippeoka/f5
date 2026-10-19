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
The bundled protocol version is now 31, integrating main's released version 29 and
adding the guided-review RPCs. No history was
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
  reads. Explicit manual sync now waits for read admission after rate-limit reset,
  releases scheduler queue capacity while sleeping, and cancels on account changes.
  It never replays mutations or an already-admitted failing operation. Manual sync
  following an in-flight background sync retains its interactive scheduling scope.
  The remaining 15g verify-first scenarios and merge-read policy are still obligations.
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

The isolated branch subsequently integrates main `f711d43051` through an additive
merge. It retains main's workspace-move snapshots and recovery proofs, its MCP
settings/runtime UI, and migration 123. Cleanup keeps both the active-thread
maintenance exclusion and verified owned-copy rollback checks; only automatic
cleanup gets the environment-file exception. Protocol 30 combines both branches'
contracts. No history was rewritten and the shared main checkout was untouched.

On this combined source, formatting, lint, all eight typecheck packages, the
required-upstream ledger and whitespace checks pass. The complete web unit suite
passes 2,280 tests, the exhaustive Git matrix passes all 162 cases, and the
selected Markdown/Mermaid/MCP runtime browser suites pass 13. The earlier full-app
shell execution case also passes, checking the exact sent command, fresh terminal,
worktree directory and absence of a model turn.

The complete post-merge server unit run passes 4,851 cases and fails only the
three launcher process-identity cases (12 existing skips). All workflow-storage
retention checks now pass on the preserved concurrent workflow changes. The full
repository gate was rerun after integration and again stops at the same two
scripts creation-identity cases. These failures remain required gates, not waivers.

The continuation adds `chat.sendAndNew` for existing-thread composers. It waits
for durable submission admission, preserves the draft on failure, and checks the
live router before navigation, including after asynchronous draft settings reads.
Mod+Alt+Enter follows the plan; the previous default for steering is removed to
avoid two actions on the same key. User steering bindings remain supported. The
focused web keyboard suites pass 68 cases and shared defaults pass 11.

The final send-and-new Chromium run passes all three acceptance, rejection and
navigate-away cases. All eight typecheck packages pass, followed by a separate
web typecheck after the final router guard. Formatting, lint, upstream coverage
and whitespace checks also pass. The combined server build succeeds. These UI
additions do not change the recorded failure of the full test gate or complete
the remaining workstreams listed above.

## Guided reviews, sync admission and scoped thread tools

The continuation implements manual reset waits, guided-review storage and UI, and the
initial thread tool catalog. These are implementation additions; no ledger entry has
been promoted while the full catch-up gate and remaining workstreams are unfinished.

- Manual sync waits only for read admission, frees its queue slot while waiting,
  cancels on account replacement and retries a rate-limited HTTP read once. Mutations
  and failures of an admitted operation are never replayed. Interactive sync retains
  its priority when queued behind a background sync. Scheduler/API/coordinator and
  discovery checks pass (118 targeted cases plus the 13-case discovery suite).
- Migration 124 stores review guides by account and PR, including run state and head.
  Generation is service-owned, coalesced, bounded to two workers/eight admitted PRs,
  and limited to three minutes. Publication checks account generation and the fresh
  head. Failed regeneration retains the previous guide; restart clears obsolete runs.
  The normalizer clamps excerpts and notes and adds omitted files to a skim stop.
  The model override is nullable and falls back to git text generation settings.
  The service and normalization checks pass 15 cases including account replacement,
  default-model fallback, failed regeneration, quoted UTF-8 paths and stale heads.
- The beta Guide tab supports generation, polling, stops, excerpts, notes, settings
  and retry. Both PR-head and loaded-diff-head changes hide excerpts. Its browser
  checks and the PR details/thread-summary/model-settings regressions pass 19 cases.
  GitLab's blank native head is now unavailable; native GitLab, Forgejo and both
  short/full Bitbucket head metadata have seven regression cases. This generator
  reads the bounded forge diff; it does not need upstream's temporary Git checkout
  or fetch-by-abbreviated-hash path.
- The `f5_thread` catalog contains thread status, guide read/generation, HTML publish
  and HTML screenshot tools. HTTP credentials are scoped to the thread and catalog,
  and disposed with sessions. Claude uses an in-process SDK server. ACP checks HTTP
  capability and excludes synthetic/read-only sessions; thread tools work on web
  servers as well as desktop. OpenCode and Muse receive no new catalog. Watch and
  settle tools remain obligations of their respective workstreams.
- Generated pages reuse the screenshot attachment ingress, recovery, ownership and
  200-item/64-MiB thread budget. Local images pass the existing inode/containment
  checks, including symlink/traversal rejection, before inlining. Source is limited
  to 512 KiB, individual images to 10 MiB and prepared pages to 25 MiB. Preview
  requests use expiring authenticated HTTP document reads rather than large socket
  pushes, with two admitted requests and a 15-second deadline.
- The desktop screenshot implementation uses offscreen sandboxed BrowserWindows,
  no Node integration, isolated ephemeral sessions, blocked navigation/popups and
  an eight-MiB PNG limit. Three desktop unit cases verify configuration, ownership
  authorization, deadline teardown and admission bounds. Actual native Electron
  execution remains subject to the previously recorded host smoke failure; these
  mocked checks are not a native certification claim.
- HTML rows use opaque `allow-scripts` frames with first-policy CSP, bounded fetches,
  fullscreen/zoom, external links and the existing image viewer/copy path. A private
  MessageChannel is established by the first bootstrap script before page code;
  raw window messages cannot invoke app actions. Native key getters are captured
  before page code so configured trusted shortcuts still work after prototype
  replacement. Six Chromium cases cover isolation, links/images, fullscreen Escape,
  forged messages/handshakes and shortcut forwarding. The source, preview broker,
  catalog and shared attachment regressions pass 20 server cases.

All eight typecheck packages and the 570-case desktop unit suite pass at this point.
Formatting, lint (warnings only) and whitespace checks pass. The overlapping broad
web runs hit two five-second import/render timeouts under load; the serialized rerun
and current complete server results are recorded below when finished. The mandatory
full gate remains outstanding, with the existing process-identity failures unchanged.

The serialized complete web unit rerun passes all 2,280 cases. The broad server run
identified an additional regression: sync was waiting through the scheduler's
network-failure circuit as though it were a rate-limit reset. Separate network and
rate-limit deadlines now preserve both cooldowns, and only rate-limit reset waits
are admitted. A failing-before recovery scenario now passes in the 49-case PR Hub
suite; together with scheduler and wait tests, all 62 targeted cases pass. The broad
run before this correction passed 4,890 server cases, failed that scenario and the
three existing launcher creation-identity cases, and skipped 12. Those launcher
failures still reproduce the host's denial of `/bin/ps`; they are not waived.

## PR watch continuation (2026-10-19)

The pinned upstream `evaluatePullRequestWatch` decision logic is ported with its
15 behavior cases. Migration 125 persists watches per thread, account and PR.
Incarnation IDs and version compare-and-swap checks reject late results after
Stop/restart. Polls share account/PR reads, use conditional GitHub fingerprints,
revalidate the verified account generation before publication, bound pagination,
and preserve the remark watermark after partial reads. Quiet native-forge reads
fall back after ten minutes; GitHub activity has a thirty-minute safety refresh.
The real GraphQL quota cost has not been certified against a live account.

Watch state and automatic NextTurnQueue submissions commit in one transaction.
Trusted automation provenance is stored separately from message text. The new
`pull_request_watch` queue reason allows Stop to remove pending watch continuations
while retaining restart-recovery protections and the ordinary queue capacity.
Manual Stop atomically removes the watch and cancels its pending wakes. Archive,
turn interruption and terminal PR state stop watches; rate limits pause without
counting toward eight failed reads. Watch state has a 64 KiB bound, global/thread
limits, four concurrent PR reads and a sixty-second read deadline.

Protocol 32 exposes list/start/stop and change pushes. Scoped thread catalogs gain
watch/unwatch for Codex, Claude and eligible ACP providers. The header's PR menu
starts/stops a watch; its eye stops it directly. Watches without an explicit PR
link remain visible and stoppable. The feature starts only on explicit request.

Validation so far: 90 focused watch, forge, cache, catalog and queue tests passed;
the final service suite adds account-incarnation and quiet-fallback cases (8 pass).
Three Chromium menu/eye/push/failure scenarios pass. Formatting, lint and the
4,084-record ledger check pass. Full workspace typechecking initially found two
incomplete mock definitions; those definitions have been corrected and all eight
workspace typechecks pass. `bun run test:full` ran again and failed on the same two
migration recovery process-identity checks (`ps` EPERM): 330 script tests passed.
This is not a waiver or a declaration that the full plan or cut line is complete.
Settlement and the other outstanding workstreams remain implementation obligations.

Durable Stop follow-up: archive, deletion, turn interruption and session Stop now
remove saved watches and pending watch submissions inside the orchestration command
transaction. This prevents a restart between command acceptance and live subscribers
from reviving a watch. Already admitted/dispatching deliveries remain recoverable.
The direct transactional regression and full engine suite pass 32 tests.

## Settlement continuation (2026-10-19)

Migration 126 and protocol 33 add persisted settlement state, per-thread opt-out,
wake anchors and server/project rules. Both automatic rules default off. The
server checks queue, request, background-work and watch state within the settlement
transaction. New work prepends its wake to the same event transaction. Persisted
human/automation provenance makes the PR timestamp rule conservative for unknown
historical messages. PR reads share one result per key per sweep, admit four
threads concurrently, cap remote reads at 32 with a 15-second deadline and rotate
the starting thread for fairness. Newly linked PRs are tracked before reading;
stale reads and account-generation changes retain active threads.

The sidebar has a collapsed Settled group, explicit wake control, row/menu actions,
a project bulk-idle action and an unbound toggle command. The header exposes the
per-thread preference. Global and project settings use the existing persistence
and source routing; checked-in files cannot opt into automatic rules.

Settlement scripts use durable pending/running/completed/failed/canceled/orphaned
jobs and the shared owned-project-process runner. Cleanup protects pending,
running and orphaned claims. Ordinary failure adds a fixed notice and releases
its claim only after owned process finalizers finish. Success and failure trigger
a fresh cleanup safety evaluation. Restart never replays an unverified running
script; its orphaned claim cannot be overwritten by another settlement. Wake
cancels the live job before releasing its claim. Idle terminal closure uses a
fresh child-process probe, checks intervening input and preserves history.

The plan's migration numbers 117/118 are already occupied by integrated main
work; this implementation uses 126 rather than rewriting migration history.
Closed-PR settlement requires the same explicit opt-in as merge settlement,
and future snoozes and pending user inputs remain protected as required by the
approved f5 plan. Upstream default-on and automatic snoozed-settlement behavior
are intentionally not adopted. The individual September and October settlement
follow-up proof remains to be reconciled; no ledger entry is promoted by this
implementation alone.

Settlement validation passes the focused server suites (180 distinct cases after
correcting the on-settle-only resolver regression), all 54 storage maintenance
cases, all 48 sidebar/control Chromium cases, 104 earlier store/sidebar unit
checks and 52 subsequent visibility/attention/preload checks. The settings
contracts pass, including partial cleanup-patch preservation and the 365-day
bound; shared project settings pass all ten checks. The exhaustive real-Git
matrix passes 162 cases again. The required full command ran and stopped at the
two existing migration-recovery process-identity failures (330 scripts checks
passed). Final typecheck and format results are tracked with the implementation
commit; this record does not waive the failed full gate.

## Codex MCP apps continuation (2026-10-19)

Migration 127 and protocol 34 add owned MCP app snapshots, live-session RPCs and
persisted latest model context. The native protocol manifest includes resource
reads and tool calls. Completed Codex MCP tool calls capture exact `ui://` HTML
resources before turn completion, with ten-second capture deadlines, two active
reads and bounded admission. Failure retains the ordinary tool row. Captures are
owned by adapter scope and release completion barriers on shutdown.

The web host ports the pinned upstream MCP JSON-RPC host into the existing F5
runtime. Apps use opaque sandboxed frames, declared-origin CSP, theme and cookie
compatibility bootstraps, and a private document-liveness channel. Navigation,
unmount and replacement revoke bridge access. Live session identities bind tool
approvals; both the RPC service and native manager re-read tool visibility and
read-only annotations before a single mutation. Every app message uses explicit
confirmation and normal durable submission. Saved context has per-app and aggregate
budgets and is delivered separately from the user text on the next ordinary Codex
turn. Offline frames explain how to reconnect; prior-turn apps remain visible when
work logs collapse. Fullscreen exits on Escape or any app/native approval.

Source reconciliation covers #16236 (capture, routing, context and host), #17026
(saved-document theme bootstrap), #17027 (blocked-cookie compatibility), #17962
(scrollable full argument approval with visible decisions), and #20691/#20759
(stable bridge lifetime without manual memo hooks). F5 snapshots already travel
through its owned attachment route; upstream's signed asset URL/cache refresh
mechanism has no matching implementation to copy. Instead, the attachment ID and
frame nonce define bridge lifetime, and a browser regression preserves the bridge
through native approval updates. Mobile branches remain outside this web/desktop
port. Individual ledger promotion still requires the plan's release gates.

Validation: the nine provider/capture/context suites pass 574 cases (one existing
skip). The subsequent native-input test brings the adapter suite to 69 cases and
passes alongside both capture cases. All 78 app/timeline Chromium scenarios pass
before the additional long-argument approval scenario; all ten app scenarios then
pass with that bounded-approval case. Shared policy/encoding tests pass 17 cases,
and the final web host/session/timeline unit suites pass 165. All eight workspace
TypeScript checks pass, lint has no errors, and the required full command ran:
330 script checks pass and two process-identity recovery checks fail because this
host denies `ps`. The full gate remains failed; no completion waiver is claimed.

## Project provider policy continuation (2026-10-19)

Project settings now include a narrow per-instance enabled policy. Omitted policy
maps survive partial project patches, an explicit empty map restores inheritance,
and resetting the whole project clears it. Checked-in files cannot change it.
The shared resolver handles default and custom instances. Project resolution
preserves opaque driver configuration and selects a project-enabled fallback for
background text generation. The original saved model preference remains intact.

Runtime hydration activates a provider when a project explicitly enables it,
while registry reads, refresh results and push streams retain global enablement.
Session admission checks the requested project independently. Turn delivery and
session recovery recheck that policy, while stopping a session remains available. Model pickers and
new-draft defaults apply that same resolver. The Project settings page lists each
configured provider and can restore global inheritance. Agent Bridge lists accept
an optional exposed project ID, reject hidden projects and apply the policy before
new-thread provider selection. Title and Git generation resolve the registered
root or linked worktree with the same shared project lookup, use an enabled
fallback and fail closed when every provider is off. Custom ACP remains a separate
unfinished part of 15k.

Focused validation passes 111 server policy/admission/bridge/generation tests,
28 publication/Git-manager regressions, 25 shared settings cases, 22 web unit cases
and 12 settings/model-picker Chromium scenarios. All eight workspace typechecks
pass before the final admission regression. The required full command ran again:
330 script tests pass and the same two migration-recovery checks fail on denied
process-identity probes. Formatting, lint and the upstream ledger check pass.
No deferred ledger obligation is promoted solely by these implementation tests;
the full gate is still failed.

## Cross-feature integration follow-up (2026-10-19)

The broad server suite exposed integration failures hidden by the root test
command's earlier script failure. The settlement migration now reuses the
idempotent core-schema repair before adding foreign-key dependents, skips missing
historical provenance and safely ignores malformed historical JSON. A direct
regression verifies repeated migration, row preservation and positive-evidence-only
automation backfill. Migration fixtures now use shared child-first teardown with
foreign-key checks kept on. Exact projection expectations include the new optional
settlement fields. All seven watch/settlement/MCP thread-reference tables have an
explicit cascade purge policy; the existing schema-coverage test verifies their
foreign keys. The passive reconciliation runtime fixture includes the new service
tags so it exercises its intended asynchronous path.

The focused schema/projection/purge run passes all 81 cases; the new provenance
suite passes both cases, and the passive-reconciliation regression passes. All
eight workspace typechecks and formatting/lint pass. The broad suite is rerun
after these fixes: 4,998 cases pass and twelve are skipped. Only three launcher
process-identity checks fail under the host's `ps` restriction. This is not a waiver.
The ledger and classification artifact attach implementation SHAs and scenario
files to the six MCP app entries and #17879. Their dispositions stay deferred
while the required full-workspace gate is failed.

## PR comment filter continuation (2026-10-19)

The Review threads tab now has persisted, independent bot-comment and resolved-thread
filters, both hidden by default. GitHub bot metadata and native forge bot flags are
retained, with the standard `[bot]` suffix as a fallback. Unknown authors remain
visible. Filtering never changes resolution or reads extra pages automatically;
a bot-rooted thread with unloaded replies stays reachable so a human reply cannot
be stranded. Both thread and reply pagination remain available.

Nine focused server cases, 131 web unit cases and both Chromium scenarios pass.
The browser scenarios cover persisted choices across remounts, independent filters,
and loading a human reply beneath a hidden bot root. Formatting, lint, all eight
workspace typechecks and the pinned upstream ledger check pass. This implements
the plan's Review threads surface for #17645; the remaining PR UX work and full
release gate are still outstanding. Ledger dispositions remain deferred.

## Per-item forge permissions continuation (2026-10-19)

Native discussion normalization now retains optional `canEdit` and `canResolve`
answers. Explicit edit permission overrides authorship; explicit resolution denial
narrows repository capabilities. Timeline edits, thread resolve/reopen controls and
fresh server-side preparation/submission checks use these answers. Saved previews
cannot authorize an edit or resolution after the host revokes it. GitHub timeline
queries also read `viewerCanUpdate` on issue and inline comments, retaining the
older authorship fallback only when the host omits the field.

The six focused server suites pass 39 cases, including permission revocation
between preview and submission. Six Chromium cases cover native editing and the
absence of a denied resolve action. Formatting, lint and all eight TypeScript
checks pass. The required full command ran for this continuation: 330 script
checks pass and the same two process-identity recovery checks fail. No full-gate
waiver or ledger promotion is claimed.

## PR link and panel continuation (2026-10-19)

PR links now open a reusable PR surface beside the originating thread. The normal
PR model and mutation paths are reused; opening a link only reads the forge and
saves its local tracked-PR model. Tab identity is the PR reference, so repeated
links reuse the tab; normal close history can restore it. No current thread uses
the existing PR route. The Browser setting can send all PR clicks to the system
browser, and modified/middle clicks explicitly bypass both the PR panel and the
preview browser. The web-local setting lives only in `appSettings.ts`.

Panel action confirmations reuse the existing forms and durable submission paths
inside the panel. They preserve the thread draft, and preparation still requires
a second explicit submit. Failed panel reads offer Retry and Open on forge. Every
read captures the selected account generation and discards a response after an
account change. This implements the F5 surfaces for #19719, #19854 and #17710.

Validation passes 19 Chromium scenarios across link routing, account response
ownership, inline merge preparation/confirmation, panel hosting and Browser
settings. The focused unit run passes 148 cases. Formatting, lint and all eight
TypeScript checks pass. A subsequent broad web run is recorded separately below.
The release gate remains failed on the process-identity checks described above;
these implementation scenarios do not promote the deferred entries.

The broad web suite passes all 2,301 cases in 236 files. A follow-up directional
permission regression also preserves a host's separate reply, resolve and reopen
answers through shared native normalization; all 23 focused model/operation cases
pass. The exhaustive real-Git matrix from the prior integration run remains 162
passing cases; this UI continuation does not change Git execution.
