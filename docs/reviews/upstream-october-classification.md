# October 2026 upstream catch-up classification

This artifact tracks triage separately from delivery. `scripts/upstream-ports.json` is the only delivery authority. A `planned` classification remains deferred until a scenario has implementation or equivalence evidence.

## Current review handoff (2026-10-19)

Implementation is on `fix/upstream-october-review` in the isolated checkout
`../f5-upstream-october-review`. Main `f711d43051` was merged additively in
`401725257a`; user work in the original checkout remains intact. The implementation
through `42d9a5862e` includes guided reviews, scoped thread tools, HTML renders and
manual GitHub reset waits. PR watches are the current continuation. Migration 125
and protocol 32 extend the merged baseline. Coverage remains 4,084 ledger records;
implementation work does not automatically promote deferred obligations.

The full gate and verify-first/security obligations remain incomplete. See
[the review response](./upstream-october-review-response.md) for the current
validation and remaining work.

## Frozen selection

- Base: `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc` (2026-09-23).
- Target: `da7c4f234db35096af2c16d5e24c60dbe9495583` (2026-10-17).
- Selection: `git rev-list --first-parent base..target`, newest first.
- Count: 1,752 unique commits.
- SHA-list digest (LF-joined with a final LF): `863fdeb7e3232508be82ddc98dd7b861325e921565089c6d3eb9b5b3b2468100`.
- Ledger: 4,084 records, comprising 3,588 interval commits and 496 legacy commits.

## Rule order and review boundaries

1. Explicit SHA and PR decisions, including accepted, declined and excluded features.
2. Follow-ups to September features retain the September workstream id.
3. User-visible shared-subsystem fixes and performance changes require scenario verification in 15a, 15r, 15t or 15u.
4. Mechanical exclusions follow source inspection. Runtime refactors are retained as deferred when there is no proof that they are behavior-neutral. Mobile-only source changes have no shared f5 runtime to port; mixed web/mobile changes retain the web work.
5. Product declines retain f5’s inbox, tool cards, icons, branch prefix and explicit compaction behavior.
6. Equivalence requires local source and implementation SHAs.
7. Remaining changes stay individually deferred. The title of a refactor or chore never proves that it lacks behavior.

The artifact deliberately retains runtime changes whose source/scenario review is unfinished. It does not assert that all verify-first cases have been reconciled. Review references use immutable upstream SHAs, available through `git show <sha>`. Each planned SHA has a scenario id and target module in the artifact.

## Counts

| Classification                                                  | Commits |
| --------------------------------------------------------------- | ------: |
| `declined`                                                      |      11 |
| `deferred`                                                      |     445 |
| `equivalent:apps/server/src/storage/databaseSpace.ts:1`         |       2 |
| `equivalent:apps/web/src/lib/nativeTaskActions.ts:14`           |       1 |
| `equivalent:packages/shared/src/codexProtocolManifest.ts:6`     |       2 |
| `equivalent:packages/shared/src/model.ts:591`                   |       1 |
| `equivalent:packages/shared/src/model.ts:71`                    |       2 |
| `not-applicable:devices`                                        |      12 |
| `not-applicable:maintenance`                                    |      58 |
| `not-applicable:marketing`                                      |       3 |
| `not-applicable:mobile`                                         |     136 |
| `not-applicable:multi-environment`                              |       1 |
| `not-applicable:relay-cloud`                                    |      45 |
| `not-applicable:release-ci`                                     |       4 |
| `not-applicable:upstream-only-subsystem:context-handoff`        |       3 |
| `not-applicable:upstream-only-subsystem:lineage-delegation`     |       7 |
| `not-applicable:upstream-only-subsystem:source-control-gitcafe` |       2 |
| `planned:10`                                                    |      49 |
| `planned:11a`                                                   |      46 |
| `planned:12a`                                                   |     102 |
| `planned:13b`                                                   |      57 |
| `planned:15a`                                                   |     319 |
| `planned:15b`                                                   |      16 |
| `planned:15c`                                                   |      21 |
| `planned:15d`                                                   |      11 |
| `planned:15e`                                                   |       6 |
| `planned:15f`                                                   |       1 |
| `planned:15g`                                                   |      18 |
| `planned:15h`                                                   |      11 |
| `planned:15i`                                                   |       8 |
| `planned:15j`                                                   |      12 |
| `planned:15k`                                                   |       8 |
| `planned:15l`                                                   |      21 |
| `planned:15m`                                                   |      13 |
| `planned:15n`                                                   |       2 |
| `planned:15o`                                                   |      21 |
| `planned:15p`                                                   |      12 |
| `planned:15q`                                                   |      10 |
| `planned:15r`                                                   |      35 |
| `planned:15s`                                                   |      10 |
| `planned:15t`                                                   |     158 |
| `planned:15u`                                                   |      45 |
| `planned:15v`                                                   |       5 |

## September carriers

The frozen set has 299 unique SHAs, SHA-sorted digest `4f6231f46344259953bb78400a81fd22d106613aa954cd38ebe99e4f822003ed`. The current baseline has 12 original workstream ids; splitting 13d into its carried and retained subsets yields 13 carrier partitions. All original ids and existing proof are preserved.

| September set  | Carrier                  | Members |
| -------------- | ------------------------ | ------: |
| `10`           | 15o                      |      30 |
| `11`           | 15t                      |       1 |
| `11a`          | 15q                      |      22 |
| `11c`          | 15t                      |       3 |
| `12a`          | 15j                      |      90 |
| `12b`          | 15j                      |       3 |
| `13a`          | 15s                      |       1 |
| `13b`          | 15s                      |      31 |
| `14`           | 15s                      |      25 |
| `2`            | 15a                      |      89 |
| `3e`           | 15o                      |       1 |
| `13d:preview`  | 15o                      |       1 |
| `13d:deferred` | carried forward deferred |       2 |

15b handles diagnostics within September set 2. The other 458 previously unassigned deferred records remain outside this round unless named as prerequisites. Carriers are reconciliation obligations, not evidence that a delivered feature needs rebuilding.

The 26 September settlement exclusions are overlaid as deferred/15c with reason “Reclassified 2026-10 by user decision”. The September JSON remains untouched. Reapplying September followed by October restores the overlay and preserves completed proof.

## Product decisions

Accepted: HTML renders, Mermaid, MCP apps, Claude `/goal`, PR hub additions, per-project providers, custom ACP agents, Pi, scratch threads, projects from a name, prompt links, settlement, opt-in native usage history, the standalone CLI installer, gated passkeys and bounded diagnostics with opt-in OTLP.

Declined: Working sidebar, secret-request cards/history scans, macOS default-browser registration, `t3/` branches, cardless tool rows and related redesigns, Morph icons, compact-before-send, mobile-app promotion and the anonymous-usage note. Preserve final upstream reverts: no automatic pre-resume compaction, file-link repair or trailing toast icons.

Excluded architecture: devices/simulators, webhooks, outside-agent OAuth, relay/cloud, multi-environment, GitCafe, Lineage/delegation/child threads, context handoff, scheduled tasks, analytics-feedback and the Tiptap composer. Keep f5’s Agents panel, Lexical composer, model catalogs, profiles and Agent Bridge.

New automatic behavior remains off. Existing defaults for usage-limit resume, restart resume, automatic default-branch pulls and storage cleanup remain unchanged. SQLite keeps its current synchronous level. The separate reader worker (#19382) is deferred: f5 uses one connection behind a semaphore; revisit if `perf:server` shows read blocking.

## Required cut line

Phase 0, 15u-1, 15a-1 and 15v must be delivered, and every verify-first item in 15a/15r/15t/15u needs an evidenced ported, equivalent or not-applicable decision, before treating the interval as caught up. Other work may remain deferred with its workstream id. Pinning coverage records review scope; it is not completion credit.

## Baseline and validation

Implementation is isolated in `../t3code-october-2026`, branch `f5/upstream-october-2026`, initially from origin/main `0b07438184417a6f82f91105609d8b404d8ae643`. The shared checkout has not been modified. After review, origin/main `97df84626a` was merged without rewriting history. It includes migration 119 (`WorkspaceTransitions`) and released protocol 25, so the next migration is 120 and the October bundle uses protocol 26. Workspace transitions remain in the generated-branch path; the prepared commit is revalidated after a coordinated switch, and a stale result reports an already-created branch accurately while suppressing commit, push and PR creation.

Baseline checks (Node 26.11.1, Bun 1.3.11):

- Focused FileViewPanel: 9 passed; the reported timeout did not reproduce.
- Scripts: 324 passed, 2 failed before changes. Both failures are migration recovery’s OS creation-identity lookup: this host rejects `ps` with `EPERM`. Recovery correctly refuses to proceed when identity cannot be verified. No assertion or recovery protection has been weakened.
- October artifact tests: 6 passed. The scripts suite still has those same two baseline failures.

Final validation results and delivery proof are recorded separately; this document does not declare the catch-up complete.

## Implementation status (2026-10-18)

This is a partial implementation. The catch-up cut line has not been met and the broader accepted feature work remains deferred.

- Phase 0 tooling and triage: `554be0af57`. Exact interval coverage, frozen September carrier membership, settlement overlays, replay preservation and deleted-classification guards are implemented. The three final upstream reverts remain verification obligations, rather than being mislabeled as behavior-neutral maintenance.
- 15u-1 cleanup safety and Git argument hardening: `2a14ab0c6d`, with checkpoint-ref follow-up in `98b3ebb081`. After review, the probe lists untracked files regardless of repository configuration, collapses ignored directories and uses a separate bounded pathspec scan for protected environment-file segments at any depth. Both ignored scans report truncation and fail closed. Automatic cleanup audits other ignored paths with a bounded UTF-8 preview and omission count. Manual removal retains the original conservative policy (only dependency directories may be removed). Real-Git tests cover over 1 MiB of ignored paths, nested secrets, truncation, hidden files, ordinary output and lifecycle races. Worktree creation also terminates options before paths and refs.
- 15u-2 commit generation: context is built with a disposable index, preserving partial staging, materializing split-index dependencies and retaining Git's racy-edit detection. HEAD, real-index bytes and the included tree are revalidated under the repository lock after generation. A changed context preserves the entire suggestion, creates no feature branch and performs no commit, push or PR request. Feature-branch creation occurs only after validation. Coverage includes concurrent staging, HEAD movement, included edits/deletion, unrelated edits, unborn/missing/conflicted/split indexes, cancellation and same-size racy edits. The full real-Git matrix passes 153 tests; the changed-context UI and goal header pass 10 Chromium browser tests. The clone-cancellation fixture now uses context-independent polling with the same assertion and 10-second deadline.
- 15a-1 SQLite implementation: `f049aa6364`, followed by review fixes. Node connections retain FULL synchronous writes, enable checkpoint full-sync and avoid cached prepare failures. Node and Bun write transactions begin immediately; `withReadTransaction` uses deferred BEGIN on the same reserved connection for consistent multi-query snapshots without taking a write reservation. Startup bounds retained WAL size and optimizes planner statistics after migrations. The Node worker has one outstanding request plus one pending check, a default-checkpoint fallback and WAL diagnostics. Contention is reported only after an incomplete passive attempt, with no claim that a reader is the only possible blocker. Unknown NOOP progress retains the previous state; busy/incomplete checkpoints retry while idle, including after an external reader releases without another writer command. The 23 correctness tests cover a 100 MiB write, pinned readers, startup failure and worker exit, exclusive-lock recovery, nested read snapshots, and separate Node/Bun processes contending before their first transaction read. The dedicated 40 MiB checkpoint benchmark completed five warmups and thirty measured repetitions; the latest largest measured event-loop p99 was 1.750015 ms, below 50 ms. Its raw report is `/tmp/f5-october-checkpoint-measurement-2.json` and records source-dirty status, source commit, runtime, hardware and fixture/harness digests. Other comparative performance and retained-memory gates remain outstanding.
- 15v preview/startup protection: `98b3ebb081`. Snapshot extraction runs in an isolated renderer world, masks password/CSS-masked values in text, names, selectors and diagnostics before truncation, rejects oversized secrets, and bounds hung or navigating captures. Token-bearing browser launch effects are excluded from tracing. Cross-origin child-frame coverage in Electron is not yet verified, so #20446 remains deferred.
- 15f Claude goals: root synthetic `/goal` output and Stop-hook feedback now publish the existing `nativeGoal` metadata. Successful root model completion clears the active status; command-only, stopped, hook-blocked and failed turns retain it. Cursor metadata restores goals after a restart, and ordinary or child model text cannot set or clear them. The existing Codex native-operation path keeps goal control operations outside the conversation-turn count. The Claude adapter and goal/resume suites pass 302 tests.
- 15u/15a passive Git reads: a pre-fix reproduction showed a timestamp-only change causing status polling to rewrite the real index. `diff-files`/`diff-index` now preserve both the index and the existing status totals; GitService disables optional writes, and automatic status/checkout refresh fetches use `--no-auto-gc`. A real Git trace verifies that polling does not start maintenance, with an ordinary-fetch positive control. Legacy worktree listing retries only the pre-2.36 `-z` usage error, decoding C-quoted Unicode/control characters while retaining literal whitespace. Unrelated errors remain visible. Existing explicit index-lock reporting is retained.
- 15b local tracing: the retained queue is capped at 4,096 records and 4 MiB of UTF-8 data, including the dispatched batch. Old pending records drop first; oversized and failed batches are counted, rather than replayed. One owned writer process performs file I/O and rotation, with bounded batches, failure backoff and a 2-second local shutdown deadline. A real FIFO regression demonstrated that a blocked filesystem call in a worker thread prevented Node from exiting even after `terminate()`/`unref()`; the separate process fixes that case. It uses the standalone private runtime where present and does not inherit provider credentials. External export, Diagnostics UI, heap capture and the other 15b signals remain unfinished.
- Existing 15v protections have separate equivalence proof: internal Claude catalogs are in-process SDK servers; Windows npm shims resolve to direct Node invocations; f5 has no DPoP/relay replay-marker producer. The Git option-hardening record is ported.

Feature commits do not change the delivery ledger. Separate ledger commits record only verified per-SHA proof. Artifact reapplication preserves that proof. The ledger includes the separately verified Claude-goal port. Commit-generation delivery proof is recorded only after its feature commit; no unresolved performance, security or carrier obligation is promoted automatically.

The 299 September carrier obligations and 26 settlement overlays are preserved but remain unreconciled as delivery work. Verify-first triage across 15a, 15r, 15t and 15u is unfinished. HTML/MCP apps, PR transport/watches/guides, settlement, custom providers/Pi, scratch projects, prompt links, usage history, desktop installation/passkeys, the full observability work and the remaining chat/panel changes have not been implemented in this slice.

## Check results

- `bun fmt`, `bun lint`, `bun typecheck`, `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`, and `git diff --check`: pass. Lint retains repository warnings with zero errors.
- October artifact: 6 tests pass. SQLite: 16 tests pass. Preview snapshot extraction/capture: 8 tests pass. Final extended real-Git matrix: 141 tests pass.
- `bun run test:full`: executed; the fast suite stops at the two reproduced migration recovery failures. The extended matrix was also run independently and passes.
- Earlier full workspaces with `--continue=always`: 8,513 tests passed, 6 failed. Five failures are OS creation-identity checks rejected with `ps`/`/bin/ps` `EPERM` (two migration recovery, three standalone launcher lease cases). The filesystem-watch case that timed out in that full run passed on its focused rerun. This rerun is not a waiver of the failed full gate.
- The full gate was repeated after the goal and commit-generation changes; it still stops at the same two migration-recovery failures. Targeted Git core/manager/smoke tests pass 63 cases, UI result logic passes 54, and Chromium passes 10.
- The focused observability suite passes 22 tests, including real blocked-disk shutdown, inaccessible destinations, overflow, in-flight accounting, one writer, worker-only file writes and both OTLP encodings. The enabled/disabled WebSocket observability checks pass 2 tests. The complete server unit suite after goals and commit isolation passes 4,538 tests with only the 3 known launcher process-identity failures.
- All server test invocations use `env -i` with only PATH and HOME supplied. No baseline assertion, process-identity check or timeout was weakened.

The full test gate and the remaining delivery obligations prevent declaring this catch-up complete. No performance improvement percentage or signed-desktop compatibility result is claimed.

## Observability library spike

The installed effect-smol revision `8881a9b` includes OTLP JSON and protobuf serializers
and exports both traces and metrics without a new dependency. The fake HTTP collector
in `OtlpCompatibility.test.ts` confirms both wire encodings, content types, service
resources and metric/span payloads. `OtlpExporter.ts` uses an unbounded array and can
start another export fiber at each batch threshold; these are not production queue or
concurrency bounds. Production OTLP composition must bound that path and its timeouts
before endpoints or headers are exposed in Settings. This spike does not enable export.

## SHA reconciliation discovered during implementation

The approved plan's passive-read SHA list includes changes from other Git scenarios.
Source inspection establishes the mapping: `f3a69c70c6` is checkpoint provenance
(#17161), `e65063ccf6` is clone option termination (#14781), `aef0e9ca40` is path
whitespace (#12465), and `dd5c7bd09e` is concurrent-fetch recovery (#19411).
The passive index-write fix is `447046b589` (#14718), and disabling fetch maintenance
is `95030dc674` (#13812). Delivery evidence follows each actual diff; these references
do not establish equivalence for the other scenarios.
