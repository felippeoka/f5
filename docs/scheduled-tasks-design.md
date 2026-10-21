# Scheduled tasks

Task definitions and run bookkeeping use a dedicated SQLite store, following NextTurnQueueStore. Fire deduplication, cursor advancement, ownership, capacity and recovery require transactional state. Thread origin is event-sourced so attribution survives replay.

Runs share the transport-independent turn submission path used by the UI and Agent Bridge. Stable identities and immutable commands are persisted before side effects. Existing worktree preparation, setup scripts, queue admission, provenance and delivery receipts remain authoritative. Worktree runs require isolation; preparation failure cannot fall back to the project root.

Run lifecycle follows associated submissions and turns, with ordered attention episodes and durable notification intents. Unknown delivery retains ownership and requires user reconciliation. Task edits apply to future admissions.

Croner 10.0.1 evaluates timezone-aware cron without autonomous timers; cronstrue 3.37.0 supplies descriptions. The shared wrapper restricts grammar and tests DST progression, skips gaps and canonicalizes repeated wall times to their first occurrence. Catch-up consumes the persisted first unconsumed occurrence and advances directly beyond evaluation time.

Agent scheduling requires an explicit f5.schedules grant and supervised execution. Execution authority is independent of creator provenance and is checked before delivery. Notifications are durably leased and acknowledged; an OS presentation followed by a crash before acknowledgement may cause a duplicate.

## Review corrections

The active change set is now in the requested worktree on `f5/scheduled-tasks`, rather than only in the external implementation checkout. Existing checkouts and user changes were preserved. The old `feat/scheduled-tasks` and detached baseline worktrees were not deleted: the repository policy prohibits deleting worktrees or branches. The former implementation checkout is a detached backup of the earlier draft; it is not the delivery location.

The server review corrections include:

- Turn outcome and quiescence, rather than diff checkpoint availability, determine success. Interrupted and usage-stopped turns keep ownership while recovery is outstanding. Late source-turn events cannot overwrite a durably linked continuation decision. A canceled continuation admission fails its queue transaction instead of silently losing scheduler attribution.
- A shared cancellation fence cancels queued receipts and abandons provably unsent delivery rows before releasing ownership or capacity. Delivery workers use the submission command identity, honor cancellation before claim, and can be woken when capacity returns. Explicit user resolution also fences tracked sends before abandoning unknown delivery.
- Startup, engine, watchdog and event listeners retry failures with capped backoff. Individual dispatch failures are isolated. Cron evaluation errors are typed effects. Startup delivery remains closed until reconciliation succeeds.
- Command reservation no longer sets the submission-start marker. Safe recovery reuses the persisted command and identities, verifies the command hash, and consumes budget once. Bootstrap timeout age uses its start time; a long capacity wait cannot prematurely time it out. Host/provider/usage lookups run outside write transactions, and reconciliation shares one orchestration snapshot per sweep.
- Disabling does not require an available provider, future cron occurrence or remaining budget. Metadata-only edits work for expired schedules and preserve schedule cursors and authority. Enabling and execution edits retain validation. Re-enable and execution adoption enforce the agent task cap.
- Global disabled intervals have bounded history summaries; exhausted one-shots are disabled on cutover. Transient provider probes are distinguished from missing providers. Ordinary delayed single fires retain the schedule trigger.
- History uses a validated opaque keyset cursor. Notification bodies use readable messages. Production constructs the lifecycle store/projector once.

Two review suggestions need qualification. Removing a thread settles a provably unsent run as `failed/thread_removed`; a known active turn or uncertain provider handoff retains ownership until stopped or reconciled. Immediate release in that case would permit overlap. Notification claims already use an atomic exclusive SQL lease, so two owners cannot simultaneously claim the same unexpired notification. Phase 2 adds desktop/browser capability negotiation and presentation.

## Delivery and verification

Phase 1 implements the server core, including the review corrections above. Phase 2 adds the Scheduled management route, project-scoped execution defaults, shared provider/model/options and prompt/skill controls, explicit NL confirmation, run history and origin badges. NL output is validated by the cron wrapper. Native notifications use the existing incarnation-bound Electron handshake and a leased outbox independently of renderer or computer-control permission; browser delivery falls back to in-app notices and wakes on pushes/reconnects/lease expiry. Ordinary thread notices check associated turn IDs, preserving notifications for later independent user turns. Phase 3 restores opt-in local MCP activation, adds explicit per-client scheduling grants, and exposes six tools through the same service. Persisted authority is rechecked before sends and continuations; revocation fences unsent work. Existing and new clients receive no implicit scheduling grant.

Current verification uses Node 24:

- `bun fmt`, `bun lint` and workspace `bun typecheck` pass (lint reports existing warnings).
- Focused server, migration, Bridge, queue, projection and bootstrap coverage: 255 tests pass.
- Real WebSocket scheduled submission and restart coverage: 2 tests pass, covering project-root and fresh-worktree execution, persisted origin, one consumed budget, and one thread/send after replay.
- Shared cron/slash-command coverage: 34 tests pass. Composer/queue web regressions: 81 tests pass.
- Scheduler timing/recovery tests use Effect TestClock, an independent wall/monotonic clock, drain barriers and no real sleeps. Coverage includes forward/backward jumps, startup and running-loop transient failures, interrupted settlement, late recovery events, canceled queued delivery, capacity wakeup, one-run budgets, reserved-command replay and expired-task disablement.

`bun run test:full` was attempted and stops before the exhaustive Git matrix at existing upstream-ledger process-identity failures (`ps` is denied with `EPERM`). A separate full server-unit run reports 4,842 passing tests and 23 failures in process inspection, editor discovery, storage/backup helpers and backup HTTP operations. The additional storage and representative backup/HTTP failures were reproduced on untouched `main`; prior baseline checks reproduced the process, editor and helper failures. No tests or ledger code were changed to bypass them.

The user explicitly authorized reproduced baseline failures as an exception to the green phase-commit requirement. That exception applies only to verified baseline failures; feature regressions must still be repaired. All three phases are delivered as separate commits.

Phase 2 verification: the production web build passes its bundle budget; browser dialog/model/ordinary-notification tests pass (15 tests), server NL and outbox tests pass, and the desktop channel tests pass (21 tests). Workspace tests retain the explicitly allowed baseline process-identity failure. Phase 2 also adds the missing public origin type alias from Phase 1 and exposes associated turn IDs through a filtered run-history lookup for precise notification suppression.

Phase 3 verification: 234 focused scheduler/Bridge/queue/orchestration tests pass, including real local MCP grant/create/run/revoke, immutable continuation settings, native user-input attention, and final-send fencing. The complete web unit suite passes 2,276 tests; focused browser settings/dialog tests pass five tests. The exhaustive real-Git matrix passes 142 tests independently of the baseline-blocked root suite. Full server unit coverage reports 4,842 passes and the same 23 baseline failures. Final formatting, lint, workspace typecheck, server build and web production build pass (the web bundle remains 40.2% below its baseline).

Phase 3 also fixes earlier-phase lifecycle cases: completed turns retain unresolved input attention; user answers are durably associated and preserve execution settings and budget; known not-sent delivery failures settle after fencing; archived-thread failures retain their reason; metadata-only edits remain possible for expired one-shots.

## Manual acceptance checklist

- [ ] Confirm NL schedules, including first Monday and one-shot examples.
- [ ] Run in a fresh worktree and explicitly at the project root; test project/provider skills and missing-skill warnings.
- [ ] Respond to approval/input attention and observe settlement.
- [ ] Restart across multiple fires; verify one catch-up, overlap/pending coalescing and capacity recovery.
- [ ] Disable queued work and verify no send; resolve ambiguous delivery without resending.
- [ ] Click desktop notifications with no renderer open and test browser fallback.
- [ ] Activate local MCP, grant scheduling, create/manage a supervised task, reject unsafe mode, revoke authority.

History retains terminal runs for 90 days with a 1,000-row per-task cap, delivered notifications for seven days, and undelivered terminal notifications for 30 days. Unfinished execution and unresolved evidence are retained. Deletion preserves existing threads/worktrees. Native notification delivery is bounded at-least-once; a crash between presentation and acknowledgement can repeat a notice.
