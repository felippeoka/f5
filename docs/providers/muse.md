# Muse Code

**Muse Code** is Meta's coding CLI. F5 runs it as a first-party provider by starting
`muse serve --approval-judge off` and speaking the Muse Session Protocol (MSP) through Meta's
official `@muse-code/sdk`, pinned to 1.4.8 (the SDK versions in lockstep with the CLI).

This is not the Muse personal agent. That agent has no public Meta API; F5 will integrate it
when one exists and does not imitate it in the meantime.

## Setup

- Install the CLI yourself: `curl -fsSL https://dev.meta.ai/install.sh | bash`. F5 shows this
  command when `muse` is missing but never runs it.
- Sign in outside F5: run `muse` once in a terminal, use `muse auth set`, or add `META_API_KEY`
  to the instance's environment variables. When `META_API_KEY` is set, the status card says it
  masks any stored browser sign-in.
- Optionally set a custom binary path on the instance.
- Muse Code is unavailable in isolated profiles.

## Runtime modes

Muse Code approves in-workspace file edits automatically in every approval mode, so F5 never
offers **Supervised** (`approval-required`) for it. The two modes F5 offers map to MSP approval
modes as follows:

| F5 mode           | MSP approval mode | What asks                                          |
| ----------------- | ----------------- | -------------------------------------------------- |
| Auto-accept edits | `promptUnmatched` | Unlisted commands and writes outside the workspace |
| Full access       | `allowAll`        | Nothing                                            |

Every start and resume reads the effective approval mode back and requires the host's sandbox
to be available. A mismatch stops the session with an error. If another client changes the
session's approval mode while F5 is attached, F5 interrupts the turn, waits for it to settle,
and stops the session. F5 never passes `--yolo`, `--disable-approval`, or `--disable-sandbox`.

Read-only workflow turns and plan mode are rejected: MSP 1.4 cannot switch a running session to
a read-only permission profile. Text generation (titles, commit messages) uses a separate
ephemeral session started with the read-only profile, which the SDK proves applied before the
prompt runs.

Because bridge turns require supervised mode, Muse Code is never reachable through the F5 Agent
Bridge.

## Approvals and questions

Each MSP approval stage becomes its own F5 request. The buttons are Muse's own choices with its
labels (allow once, allow for session, always allow, deny, abort); unknown choice kinds are
omitted. When Muse advances an approval to a new stage, the earlier request is replaced. If an
approval changes while you decide, F5 reloads it and asks you to review the updated request; it
never retries a decision automatically. Approvals answered in another client close in F5.
Pending approvals and questions reopen after a resume. An approval F5 cannot read is denied when
a deny choice is available; otherwise the session stops.

## Reliability

- F5 mints the native command id before the first send and stores it, so a retried delivery
  reuses it and the host deduplicates the turn.
- A command the host never admitted (closed transport, local or host overload, rejection,
  invalid input) is reported as not sent; a timeout after the frame was written stays ambiguous.
- Resume continues from the stored view cursor. If history after that cursor was pruned, F5
  warns, reloads the session's current state, and continues. A new session starts only when the
  host no longer knows the session, or after an in-memory host exited.
- Stop sends `turn/cancel` and waits up to 10 seconds for the turn to settle before closing the
  host.
- Rollback is not supported.

## Protocol pin

`packages/shared/src/museProtocolManifest.ts` records the SDK/CLI version, expected schema
fingerprint, and a disposition for every MSP notification. `bun run protocol:audit:muse` checks
the installed SDK against it and the fixture under `scripts/fixtures/muse-protocol/`.
`MUSE_LIVE=1 bun run protocol:audit:muse` also runs permission conformance against the real
binary. A host advertising a different fingerprint still works, with an "untested Muse Code
protocol" warning.
