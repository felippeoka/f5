# Upstream performance baseline

The Phase 0 harness collects server component measurements and a production-browser,
WebSocket and native-terminal soak. Both reports are required. The pinned original
baseline is `290d261c9c9daa0c469b312d7f62dfd4ea9b9698`; use its runtime code and
frozen dependencies when collecting it. This is measurement tooling, not a runtime
performance port. Existing baseline failures remain failures until their approved
Phase 2 fixes meet the gates.

## Run server measurements

From the repository root, with dependencies installed and the same Node version in both checkouts:

```sh
bun run --cwd apps/web build
bun run perf:server --smoke
bun run perf:interactive --smoke
bun run perf:server --output=.performance/server-before.json
bun run perf:interactive --output=.performance/interactive-before.json
# After the relevant implementation changes, on the same machine/runtime:
bun run perf:server --output=.performance/server-after.json
bun run perf:interactive --output=.performance/interactive-after.json
bun run perf:compare .performance/server-before.json .performance/server-after.json
bun run perf:compare .performance/interactive-before.json .performance/interactive-after.json
# A change targeting CPU must additionally improve its named scenario by at least 20%:
bun run perf:compare .performance/server-before.json .performance/server-after.json terminal.ingest-20
```

Run measurements alone, without the test suite, builds or other benchmarks in
parallel. Full runs use five warmups followed by 30 measured repetitions. Smoke
runs use one warmup and two repetitions and cannot be used for comparisons. The
fixture sizes are identical in both modes. No timing assertions run in ordinary
CI; correctness tests cover fixture content, sample handling and gate decisions.

Reports live in ignored `.performance/` files. Existing report files are never
overwritten. Reports include every raw wall-clock and process-CPU sample, source
commit and dirty state, fixture and harness digests, OS/hardware, actual installed
dependency versions, dependency-lock digest and runtime versions. Browser version
is explicitly null for this server-only runner. A report is published only after
all scenario correctness checks and resource cleanup succeed.

The acquisition command records existing resource-limit violations and prints
`FAIL` without failing the measurement itself. This permits collecting a baseline
of known defects. **Comparison rejects those violations**, even when timings
improve. It also rejects smoke runs, incomplete or missing scenarios, different
fixture/harness digests, incompatible hardware/OS/runtime, disappearing or changed
resource bounds, and unknown CPU target names. Dependency versions may change
between runs; both versions are recorded for review.

The p95 uses nearest-rank selection. An unaffected latency fails only when its
regression exceeds both 10% and 20 ms. Named CPU targets must improve p95 process
CPU by at least 20%. CPU values cover the Node benchmark process; they **exclude
Git and the concurrent SQLite child process**, so Git CPU optimizations require
additional instrumentation before that gate can be evaluated.

## Workloads and limits

The checked-in fixture specification is
[`fixtures.json`](../scripts/lib/performance/fixtures.json). Its generator has a
fixed seed, timestamps and pinned content digest. Data is generated outside timed
regions. All databases, logs, repositories and local bare remotes are disposable
under the OS temporary directory; user repositories, credentials and profiles
are not used. Git fixture construction disables host configuration and automatic
GC. Local transport is enabled only for fixture submodule setup.

| Measurement                            | Production path and workload                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.ingest-20`                   | Twenty `TerminalManagerRuntime` sessions receive 40 × 4 KiB chunks each, with Unicode, ANSI and CRLF. History is cleared outside timing.                                                                   |
| `terminal.persist-reconnect-20`        | Close all sessions, flush production persistence, then reopen and read histories.                                                                                                                          |
| `replay.20000`                         | Production SQLite migrations and event store; decode 20,000 ordered events, checking every sequence. The explicit replay limit avoids conflating the known default 1,000-event truncation with throughput. |
| `replay.slow-reader-with-writer`       | Same stream, pausing after each 200 events while a separate physical SQLite connection/process writes every 5 ms.                                                                                          |
| `replay.cancel-after-1000-with-writer` | Cancel consumption at 1,000 events with the writer still active; subsequent samples must replay from the start successfully. This is stream cancellation, not a WebSocket disconnect.                      |
| `git.status-large-nested-submodules`   | Production `GitCore.statusDetails` over 10,000 files, three nested repositories and two real submodules. Assert the known tracked modification is returned.                                                |

Terminal byte limits are checked separately after injecting a line larger than
4 MiB. The pinned original baseline is only line-bounded and exceeds this ceiling.
The Phase 2 terminal implementation retains at most 5,000 lines and 4 MiB of UTF-8
content, dropping whole old lines first and truncating oversized lines only at
code-point boundaries. Live output is not truncated. The PTY adapter delivers
deterministic bytes instead of starting interactive shells. Process discovery/polling
cost and native PTY integration are **not measured** by the server-component runner;
the interactive soak exercises the shared two-second process poller with native PTYs.
See [the terminal validation report](reviews/phase-two-terminal-validation.md).

## Browser, transport and retained memory

The user revised the soak duration from 30 to **10 minutes** on 2026-09-24.
Retained growth is measured over the final **5 minutes**, with the original 5% and
10 MiB thresholds unchanged. Five warmups and 30 timing repetitions also remain
unchanged. This shorter run is not evidence of 30-minute stability.

The interactive runner serves the **production-built application**, with deterministic
read-model RPC responses and the production WebSocket push controller. Playwright
uses the real router, composer, message rendering and WebSocket client. The fixture
server is not a measurement of production HTTP static-asset serving. It provides
10,000 messages, 50 image attachments, ten 1 MiB command outputs and ten streaming
threads. All ten threads are hydrated before streaming starts; each receives 20
updates/second through real sockets. Unknown RPC methods fail the run.

Measurements use browser event/paint timestamps, excluding automation transport
latency. Startup ends when the small thread and composer paint; warm switching
ends when the last large-thread message paints. Composer timing starts at captured
`beforeinput` and ends two animation frames after its DOM update, both idle and
under streaming. Renderer process CPU is recorded through Chromium's process API.

A separate socket pauses TCP reads until the production send controller rejects
queued frames and closes it. Each trial reconnects while a separate physical
SQLite connection writes. The legacy 1013 and future 4409 overflow codes are
accepted; the 8 MiB / 2,000-event limits remain fixed. This measures overflow and
reconnection, not the Phase 2 snapshot-resynchronization feature.

Every full interactive run then keeps ten streams, twenty **native PTYs** and the
SQLite writer active for 10 minutes. Terminal children have a bounded lifetime and
an owned foreground descendant, exercising the production process poller. Terminal
output and SQLite rows are bounded; terminal histories are loaded from full disposable persisted logs before timing
so their initial growth does not consume the shorter observation window; memory is sampled after garbage collection at
minutes 0 through 10. Reports retain browser/server heap, server RSS, terminal
history bytes and cumulative renderer/server CPU. Child process CPU is excluded.
The final five-minute heap growth must be ≤ 5% **and** ≤ 10 MiB for each measured
process and their sum. All 11 samples are required; a short smoke cannot qualify.
Raw browser reports and minute-progress files remain available if a run fails.

The server runner also observes real replay SQL page row counts and serialized
bytes, and measures legacy base64 attachment decoding/persistence/release using
eight 1 MiB images. These are the existing ingress path, not future generic HTTP
uploads. Replay/upload observations describe those buffers, not whole-process
heap. The separate soak measures retained heap.

## Reproducing the pinned baseline

Create a detached disposable checkout without changing its production source:

```sh
git worktree add --detach /tmp/f5-phase0-baseline 290d261c9c9daa0c469b312d7f62dfd4ea9b9698
```

Copy only the harness directories `scripts/lib/performance`,
`apps/server/scripts/performance`, the files `scripts/performance.ts`,
`apps/server/vitest.performance.config.ts`, and
`apps/web/scripts/performance-browser.mjs` into that checkout. Run
`bun install --frozen-lockfile` and build its web app there. Verify that `git diff`
contains no production-source changes (installation may regenerate the MSW public
worker; preserve the checked-in baseline version). Invoke the copied runner using
`bun scripts/performance.ts` and `bun scripts/performance.ts interactive`, since
the baseline's package manifest has no performance commands. Keep its original
lockfile and dependencies; never substitute the candidate's node_modules.

Run baseline and candidate sequentially on the same machine and runtime. Reports
must have matching fixture and harness digests. The source-dirty flag includes
untracked harness files in the old checkout; retain a separate production-source
verification with the results. Machine-specific raw reports remain untracked.
Check that each revision has both complete reports before comparing:

```sh
bun scripts/performance.ts coverage .performance/server-before.json .performance/interactive-before.json
bun scripts/performance.ts coverage .performance/server-after.json .performance/interactive-after.json
```

Coverage validation checks required scenarios, sample counts, fixed resource limits,
matching source/environment metadata and the complete memory duration. It reports
measured failures separately: complete coverage is not a passing performance gate.
Use both comparisons; neither report alone establishes complete Phase 0d coverage.

## Server performance and storage (roadmap 5.4)

The assistant-stream scenario sends bounded bursts of 32 concurrent deltas per
stream and measures each delta through its projected text. Waiting for each delta
before publishing the next would prevent a batching implementation from being
measured. The fixture still uses four streams, 500 deltas each, 2,000 seeded
messages per thread, and tool/command interruptions every 50 deltas.

For a paired coalescing comparison on the same code and hardware:

```sh
F5_PERF_STREAM_COALESCE=0 bun run perf:server --output=.performance/stream-before.json
bun run perf:server --output=.performance/stream-after.json
bun run perf:compare .performance/stream-before.json .performance/stream-after.json orchestration.assistant-stream
```

`F5_PERF_STREAM_COALESCE` is a benchmark-only override of the driver allowlist;
it does not configure the application. Production coalescing is allowed only for
Codex, whose assistant item completion includes the full final text. Claude and
other drivers retain their existing delivery behavior. Batches flush at 40 ms or
2 KiB, before other events on that thread, on controls, and during scope close.
Retries preserve the first event’s command ID and immutable text. After three
failed attempts, or a permanent rejection, the batch is dropped and logged. Later
deltas for that message wait for its authoritative completion so the stored text
stays a valid prefix. Other events and other threads continue. Set
`F5_COALESCE_STREAMING_DELTAS=false` before startup to disable batching independently.

SQLite helper ownership (R12), non-handling projector skipping (P1b), and pragma
tuning (P3) remain measurement-gated. `synchronous = NORMAL` is not enabled.

The storage gate can run the same ingestion workload while each repetition
exports a backup and a separate SQLite process holds a read transaction:

```sh
F5_PERF_STREAM_STORAGE_GATE=1 bun run perf:server --smoke --output=.performance/storage-gate-smoke.json
F5_PERF_STREAM_STORAGE_GATE=1 bun run perf:server --output=.performance/storage-gate.json
```

This reports the longest application SQL execution as well as event-loop p99,
and asserts that every concurrent export completed. Child archive/reader CPU is
not included in the parent process CPU measurement. The normal paired P2
comparison runs without this additional workload.

### Section 5.4 validation

A full paired server run (5 warmups, 30 repetitions) passed `perf:compare` with
`orchestration.assistant-stream` as the CPU target. Local reports are
`.performance/section54-final-baseline.json` and
`.performance/section54-final-after.json`.

| Streaming metric          |       Before |       After |
| ------------------------- | -----------: | ----------: |
| Wall time p95             | 10,068.59 ms | 1,069.81 ms |
| Process CPU p95           |  9,363.11 ms |   729.33 ms |
| Per-delta latency p95     |    633.61 ms |    76.97 ms |
| Event rows                |        2,070 |         143 |
| Projection SQL statements |       61,622 |       3,812 |
| Event-loop delay p99      |     16.64 ms |    15.04 ms |

An earlier attempt exceeded the unaffected slow-reader replay regression gate;
a quiet repeat passed. Retain the raw reports when comparing on another machine.
The interactive fixture was updated afterward for the native-operation list and
disk-space reads used by the current UI; combined coverage reports therefore
need the refreshed fixture/harness digests.

Formatting, lint (26 existing warnings, no new warnings), typecheck, build,
Bun readiness, SDK/protocol audits, packaged ESM/CJS and a locally built
standalone executable maintenance launch, the
Git smoke suite and all 136 extended Git cases pass. Focused tests cover streaming
order for Codex and a non-allowlisted driver, immutable retry payloads, full-text
completion recovery, backup ownership/restore/storage limits, incremental skill
scans and deleted roots, migrated summaries, and stale detail-query cancellation.
The changed-feature browser batch passes all 36 tests.

Initial full verification was not green in this environment: the full test command was
attempted, and a continuing workspace run exposed process-birth identity failures
in upstream-ledger and launcher tests, a workspace-watch race test, and the passive
Codex reconciliation test. A clean server run passed 4,116 tests with those five
server failures remaining. The full browser suite passed 790 of 791 tests; its
remaining failure concerns worktree-default branch inheritance. Desktop smoke is
blocked by the local Swift manifest/toolchain and missing Electron installation.
Authenticated live-provider certification was not run.

The full storage gate completed 35/35 exports with an external read transaction.
Its event-loop delay p99 was 13.83 ms and longest application SQL execution was
17.28 ms. Neither R12 trigger tripped. The report is
`.performance/section54-storage-gate-full.json`; it uses the refreshed interactive
fixture and includes the extra storage-gate observations.

The full interactive run completed the ten-minute soak and retained all eleven
memory samples, but failed its terminal subprocess-activity assertion: 59,738
terminal output events and zero activity transitions were observed. The process
poller depends on `ps`, which this environment denies. This run does **not**
establish passing interactive coverage. Its raw browser measurements remain at
`.performance/section54-interactive-full.json.browser.json`: 20.00 updates/second
per thread, no unknown RPCs, browser heap growth 3.06 MB and server heap growth
−0.51 MB over 600 seconds. A full passing rerun on a host permitting process-table
inspection remains required.

The standalone helper was exercised in a real locally built Node 26.11.1 SEA,
including an empty provider installation. This verifies its early maintenance
route; it does not replace the release archive smoke with the pinned Node 26.10.0
runtime and packaged native dependencies. The archive smoke now also requests a
backup with a clean PATH.

PR review follow-up adds regression coverage for exhausted/permanent batches,
legacy unregistered attachments, previously restored registry paths, settings
credential redaction/encryption, failed scheduled exports, interrupted partials,
clock rollback, failed skill refreshes and normally ended watch streams. Scheduled
results are persisted and shown in Storage settings. The passive reconciliation
CI failure was traced to a test runtime missing the newly required skill-sync
service, and that fixture is now corrected.

Review follow-up verification passes formatting, formatting check, lint (26 existing
warnings), all eight typecheck tasks, build, Bun HTTP backup export, 180 focused
server tests, all 125 WebSocket tests and 40 browser tests. The server performance
smoke also passes (stream per-delta p95 about 75 ms, 143 event rows). A new full-suite
attempt still stops at the two upstream-port migration process-identity failures
on this host. No new full interactive soak or paid provider run was performed.
