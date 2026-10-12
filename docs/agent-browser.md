# Agent browser and computer use

How agents (Claude and Codex) see and drive web pages and, optionally, this computer, and
the safety rules each path follows. Settings live in **Settings → Browser and capture** and
per project in **Project settings → Conversation**. Every flag below is ANDed with
`enableAgentBrowserAccess`. A checked-in `f5.json` can never set `previewExternalHosts`,
`enableClaudeInChrome`, or `enableAgentComputerUse` (`USER_ONLY_PROJECT_SETTING_KEYS`).

## Rule: tools installed, execution gated

Preview tools are installed in every interactive desktop session. Each call resolves the
live policy (`resolveAgentBrowserPolicy`), so toggling a setting applies on the next tool
call without restarting the session. Policy lookups fail closed.

| Capability                | Claude                                                 | Codex                                                  |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| F5 preview (`preview_*`)  | In-process SDK MCP server `f5_preview`                 | Loopback HTTP MCP `__f5_preview`                       |
| External sites in preview | Allowlist (`previewExternalHosts`)                     | Same allowlist                                         |
| Chrome integration        | Awaiting native-host certification (`--no-chrome`)     | Awaiting plugin certification                          |
| Computer use              | F5 native catalog when available; built-in gate closed | F5 native catalog when available; built-in gate closed |

## F5 preview

- **Provenance.** Claude tools are classified by exact `mcp__<server>__<tool>` name, and
  only after `mcpServerStatus()` reports the server as `source: "sdk"`. A project server
  with a look-alike name never inherits F5's exemptions.
- **Approvals.** Observation (`status`, `snapshot`, `screenshot`, `wait_for`) never prompts.
  Read-only workflow stages may observe but not write artifacts, so they get `snapshot`
  without `save: true` and no `screenshot`. Mutating tools follow the runtime mode; one
  "allow for session" grants the whole mutating family.
- **Screenshots.** `preview_screenshot` captures through a saving snapshot: the agent gets
  the image plus the saved artifact's id, without the page text and element lists.
- **Owner.** When no preview is open the server asks the most recently active window to
  host one (`ownerRequested`). The window pins a headless preview (at most 2 pinned of 4
  instances) and adds a Preview tab without stealing focus. Pins are released on user
  close, on `ownerReleased`, or after 10 minutes without agent activity.
- **Serialization and take-over.** Mutating actions run FIFO per thread (32 queued at most)
  and per tab in the desktop process. **Take over** pauses the thread: the running action
  stops at its next checkpoint (poll loops, before input, between 64-character typing
  chunks), queued actions fail with `PreviewAutomationControlInterruptedError`, and the
  agent is told to ask the user before continuing.
- **Bounds.** Snapshot images are at most 2560 px and 8 MiB (PNG, then JPEG, then smaller).
  Structured snapshot data is trimmed to 256 KiB, and the whole response must fit in 16 MiB.
  Anything larger fails with `PreviewAutomationResultTooLargeError`.
- **Diagnostics.** Snapshots include the last 50 console messages, navigation and failed
  loads, and the action timeline for the tab.
- **Screenshots in chat.** Before a tool lifecycle event is compacted into an activity,
  its inline images (PNG, JPEG, WebP, 8 MiB each) are moved into the attachment registry
  (owner kind `activity`, migration 109) and the result is scrubbed, so neither the
  activity nor its `mcpResult` text holds base64. Payloads keep only `mcpImages`
  references: one per tool item and 200 per thread, with `mcpImagesOmitted` counting the
  rest. Attachment ids derive from the thread, tool item, and content, so replayed or
  repeated events reuse one file. Bytes are staged, registered, then promoted, the same
  lifecycle chat uploads use, so startup recovery finishes or discards an interrupted
  write. Provider event logs replace inline base64 with a placeholder. Reverting a turn
  drops the ownership of its activities' screenshots, and storage cleanup reclaims the
  files.

## External sites allowlist

Grammar, one entry per line:

- `example.com`: that host over HTTPS.
- `*.example.com`: its HTTPS subdomains.
- `http://intranet.local`: one host over plain HTTP.
- `*`: any DNS host over HTTPS, after an explicit confirmation.

IP literals never match wildcards. Ports, paths, credentials, and other schemes are
rejected. Loopback is always allowed.

The desktop process enforces the list on `will-navigate`, `will-redirect`, and main-frame
`did-start-navigation`, and re-checks the current URL before and after every agent action.
A blocked navigation during an agent action fails it with
`PreviewAutomationNavigationBlockedError` (status reason `external-blocked`) instead of
opening the system browser. `preview_evaluate` is refused on any non-loopback page.
Sign-in popups stay with the user; the agent sees `popupOpen` in status and snapshots.

## Computer use v2 architecture

Computer control is opt-in and currently **awaiting certification** on both macOS and
Windows. Linux reports `unsupported-platform`. The native implementation targets macOS
14+ and Windows 10 2004+. Setting `F5_COMPUTER_CONTROL_DEV=1` enables local engineering
validation only in unpackaged builds; it cannot enable a packaged release.

Electron main is the device authority. Every profile backend inherits a private Node IPC
channel with an incarnation UUID and a versioned hello. There is no network computer host
registration and no renderer execute method. Claude's native tools use the in-process
`f5_computer` SDK MCP server; Codex uses catalog-scoped bearer credentials on
`/mcp/computer` (`__f5_computer`). Preview and computer credentials cannot be exchanged.

Main supervises an OS-specific helper, an execution lease across profiles, bounded
mutation and observation queues, replay protection and capture-excluded overlays. A
session chooses one backend. **Automatic** prefers a built-in only when its provider,
platform and version have certified consent, per-call veto, stop, observation, F5
isolation and profile isolation. **F5 only** forces the native implementation. This
preference is user-level and cannot come from a checked-in project file. Settings and
availability changes restart the provider session at the next turn. Session bindings record
the selection, installed-tool state and configuration fingerprint; replaced Codex
processes cannot deliver lifecycle or tool events into their replacement session.

The built-in certification registry is empty. The read-only availability probe identifies
installed ChatGPT plugin version/manifest hashes without enabling or importing a global
provider home. The currently installed app ships a disabled `cua_repl` placeholder that
needs ChatGPT's dynamic launch configuration. The bundled Chrome plugin has no
standalone MCP launch definition; its skill expects a host-provided `node_repl` runtime.
The readiness probe distinguishes these installed, host-managed plugins from missing or
unreadable installations and records both versions and manifest hashes in the preflight.
Codex's [hook documentation](https://learn.chatgpt.com/docs/hooks) supports explicit
PreToolUse denial but specifies fail-open behavior for callback failures and specialized
paths that can omit the gate. A hook alone cannot supply F5's fail-closed veto. Supported
runtime launch, complete veto coverage and profile isolation remain integration gates.

Claude's [computer-use documentation](https://code.claude.com/docs/en/computer-use)
requires the interactive CLI and excludes non-interactive `-p` mode used by the Agent
SDK. General SDK elicitation support does not establish supported computer-use launch
or app-access consent. These are upstream integration constraints, not permission to
start an external computer-use server or weaken F5's gates.
F5 does not guess plugin configuration, copy ChatGPT resources, start
`claude --computer-use-mcp` as an external server, or install two computer catalogs into
one session. With those gates closed the selected available backend is native, with the
built-in reason shown on both providers' capability chips. If native lacks a host, platform support or certification, no
computer catalog is installed. Recoverable helper/permission/monitor failures keep the
native catalog installed and fail calls with their current reason, without restarting
the provider session. Adding a certification record alone does not install a
provider built-in: its supported launch, consent and veto bridges must be wired before
the availability probe can return true. That runtime wiring is still pending.

| Guarantee                                     | F5 native release gate     | Built-in provider gate             |
| --------------------------------------------- | -------------------------- | ---------------------------------- |
| F5-owned machine lease and global pause       | Required                   | Required                           |
| Per-call pre-execution veto                   | Required                   | Required                           |
| Consent that the agent cannot answer          | F5 app dialog              | F5 dialog or certified provider UI |
| F5 cannot be targeted                         | Per-event ownership checks | Must be demonstrated               |
| Ungranted content excluded from capture       | Required                   | No F5 guarantee                    |
| Stop under 100 ms                             | Required                   | Current provider action may finish |
| Per-event hit testing and secure focus checks | Required                   | No F5 guarantee                    |
| Persistence sanitization                      | Required                   | Required                           |

### App consent and protection tiers

Observe `computer_status` first, then `computer_list_apps` and `computer_request_access`.
Requests show a desktop dialog and a timeline card. **Review access** opens native dialogs
owned by Electron main. The renderer only identifies the pending request; its allowance,
typing, remembering and session-action fields are ignored. Native dialog choices alone
produce the answer on the owning profile's private host channel. Requesting app consent
releases existing native execution before the dialog is shown. Cancel defaults to deny;
main revalidates request expiry and backend incarnation after every dialog. Resume of actual
computer control also requires a native confirmation, independently of renderer gestures. Web clients show “Answer on the computer running F5”. Requests
expire after 300 seconds; turn/session end closes them. Full-access runtime mode never
bypasses app consent, pause or protected targets. Other runtime modes also require a
session-actions approval; plan mode permits observation only.

| Tier    | Examples                                                                                                            | Rights                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| blocked | F5 (including dev Electron), security/permission/login UI, Settings, task management and system administration apps | Never grantable                                        |
| view    | Password managers, Keychain Access                                                                                  | Capture and inspect only                               |
| click   | Terminals, IDEs, automation apps, other agent apps; Windows Explorer app windows                                    | Interaction; typing requires separate **Allow typing** |
| full    | Other apps, including browsers                                                                                      | Interaction and typing                                 |

The authoritative catalog is `packages/shared/src/computerApps.ts`, generated into both
native builds and checked for drift in CI. Dock, menu-bar status items, Control Center,
Notification Center, Spotlight, Start, tray and desktop shell surfaces are never
application grants. Browsers carry “This app can act on sites you are signed in to”.
Typing into a click-tier app can run commands. Its native dialog defaults to Deny and
separates **Allow clicks** from **Allow clicks and typing**; remembering defaults off.
`computer_request_access` accepts `typing: true` to request a typing upgrade after click-only
access. Ordinary duplicate requests do not prompt again, and a declined typing upgrade is
not prompted again within the same turn. Full-tier native approval explicitly says
**Allow control and typing**. Unknown apps retain the plan's full-tier ceiling; identity
classification is not a sandbox and consent is required for every app.

Grants last for the provider session, across turns. “Always allow in this project” writes
server-owned `computer-access.json` under `ServerConfig.stateDir`, through serialized
atomic writes. Invalid or incompatible files are quarantined with their original bytes
preserved and startup continues without remembered grants. If quarantine fails, remembering
is disabled until storage is repaired. Session deny overrides a remembered grant. Revoke narrows live access;
Forget removes a remembered grant from project settings. Restart retains remembered
grants and drops session grants. Settings patches and model tool calls cannot add grants.
An agent with unrestricted filesystem write access can still edit these files; the
no-widening guarantee applies to the tool and consent paths.
These controls govern F5's computer tools, not every command an unrestricted shell
can run. A separate AppleScript/`osascript` or native Accessibility program is subject
to macOS permissions and its own execution policy; the F5 computer lease and pause
cannot supervise an independent process that bypasses this tool interface.

### Capture, coordinates and accessibility

Native screenshots include granted apps only. macOS uses ScreenCaptureKit include-only
application filters; Windows composes granted top-level windows with `PrintWindow` onto a
neutral canvas and never reads desktop pixels. F5 and overlays are excluded; known secure
fields in the focused window are masked before encoding. `hiddenContent` indicates that
on-screen windows were omitted or privacy masking hid content. Capture enables Chromium
accessibility before reading password fields; a truncated or unreadable masking tree hides
the focused window conservatively. AX calls have a process-wide 250 ms timeout.
An unreadable accessibility tree produces an empty,
inaccessible inspect result; it does not expose secure values through inspect/setValue.

Each display has a geometry generation covering bounds, physical pixel size, scale and
rotation. Negative origins and mixed DPI are supported by the coordinate contracts.
macOS pixel dimensions use the display mode backing resolution. Windows full-window
captures are cropped to the visible DWM frame before composition, preserving coordinates.
Coordinate input uses the actual Windows hit recipient, rejects cloaked, transparent and
ambiguous layered targets, and verifies window regions.
Model dimensions use `s = min(1, 1456 / longEdgePx, sqrt(1150000 / areaPx))` and floor the
scaled dimensions. Coordinates are integer pixels in that display's screenshot, with
exclusive upper bounds. They map through pixel centers into native space. Zoom is viewing
only; clicks always use display screenshot space. Coordinate tools require a fresh
screenshot's generation. Geometry changes fail instead of remapping silently.

Zoom crops an approved region from a sharper capture before image-size scaling; its
rectangle uses the original display screenshot coordinates. Zoom images are for viewing
only and do not replace the display geometry used for clicks.

Prefer `computer_inspect` and `computer_element_action` for accessible elements. Native
AX/UIA actions re-resolve opaque snapshot references against the live app/window and
refuse stale or secure elements. Unsupported actions return an explicit error and do not
fall back to coordinate input. Coordinate actions drive the foreground pointer and
keyboard, hit-test each emitted event, and recheck focus and grants between typing
chunks. Open/activate operations resolve apps through native installed-app catalogs;
there is no shell, arbitrary executable path or raw native message tool.

Capture images are at most 8 MiB encoded; inspect is bounded to 400 nodes, depth 30 and
256 KiB; other results are 64 KiB and complete tool responses 16 MiB. Screenshot results
reach the model intact. Persisted images use the existing attachment pipeline, with a
200-image and 64 MiB per-thread budget; excess images count as `mcpImagesOmitted`. Computer
screenshots in plan mode are not persisted. The native NDJSON line limit is separately
12 MiB; both helpers return a correlated `ResultTooLarge` for oversized responses.
This differs from the complete MCP tool-response limit of 16 MiB.

### Stop, pause and failure handling

The helper starts suspended and takes a per-user OS device lock. Another F5 build holding
that lock reports `other-instance`. Main grants one execution lease across profiles and
renews a monotonic one-second execution permit every 250 ms. Main stalls or channel loss
therefore suspend input locally. Helpers release held buttons/keys on cancel or suspend.
Their input monitor and heartbeat must remain healthy; an unhealthy monitor blocks input.
Windows verifies mouse and keyboard hook acknowledgments independently. Hook callbacks
set atomic stop flags; a separate worker releases held input.

The fixed kill chords are **⌃⌘Esc** on macOS and **Ctrl+Alt+Shift+F12** on Windows. Physical
keyboard/button input or sufficient mouse movement also self-suspends the helper before
notifying main. Main drains queued actions, latches pause, invalidates the lease, clears
visuals, and notifies the backend. A native suspend without acknowledgment within 50 ms
kills the helper; any replacement starts suspended and receives the current grants
again. Idle unavailable status never performs a timed suspend round trip. Heartbeat
health is separate from generation-specific permit-expiry notifications, so an old
suspended heartbeat cannot pause a new lease. Banner/live-card Stop suspends locally
before interrupting the provider turn. Resume is explicit and invalidates screenshot
geometry. Already-delivered OS actions cannot be undone.

Lease release is exact-holder and generation-aware. Turns release execution while keeping
grants; session disposal clears grants. Idle leases release after 60 seconds without a
mutation. Other profiles receive only an anonymous lease banner. Activity, app names, action
thumbnails and lease-holder metadata stay in the controlling profile.
Renderer loss affects UI only; main and helper retain the control/stop path. Backend IPC
disconnection cancels work and releases that backend's lease. Losing host/helper during a
mutation reports `OutcomeUnknown`: take a screenshot before retrying. Mutations are never
retried automatically after ambiguity. Duplicate request IDs join the admitted result;
different payload hashes are rejected and evicted IDs remain tombstones for their
execution generation. Transport dispatchers keep at most 65,536 invocation tombstones per
MCP initialization and refuse new IDs at saturation. Completed observation IDs are retained
as well: expiring an ID could change a late retry from rejected into a fresh call. MCP
re-initialization creates a new invocation identity scope, rejects retired session headers,
and does not deduplicate calls made with a new scope. After `OutcomeUnknown`, a client must
observe before deliberately issuing any new action; it must never automatically re-submit
a mutation after reconnect. This boundary is covered by the mutation re-initialization test.
Preview-only pause/resume remains available with missing or unhealthy computer helpers;
remote resume is refused for a held native/Chrome lease or a main-authoritative computer pause.

Overlay rendering is bounded to 280 ms and cancellation releases its queue slot without
allowing late dispatch. If an observation worker blocks in another app (including Windows
`PrintWindow`), the 10 s supervisor timeout suspends and retires the helper; replacements
start suspended and no action is retried. Three such failures in 60 s require explicit Retry.

Screen Recording/Accessibility permission failures and periodic macOS Screen Recording
re-prompts report `missing-permissions`. F5 opens the appropriate Settings pane only on
explicit user action; capture errors never silently invoke a permission prompt. Main and
helper permission identities must agree before release certification.

### Visual feedback and persistence

Main shows click-through, protected overlay windows on every display, with provider
colors, a labelled cursor, action labels and click ripples. Pause, release and display
changes clear/rebuild overlays. Chat shows transient activity, available action thumbnails,
granted apps with Revoke, and Pause/Resume/Stop. Thumbnails travel on `computer.activity`
and are not persisted. Native control of real browsers is separate from structured DOM
control, which remains in the F5 preview.

Adapter logging and central ingestion sanitize verified computer-tool provenance before
persistence. Typed text, semantic values, inspect names/values and raw error strings are
removed, including nested fields. Codex built-in `cua_repl` JavaScript and text output are
entirely omitted. This does not modify model-facing results or erase provider-managed
conversation history. Look-alike project server names do not acquire trusted provenance.
The sanitizer retains at most 65,536 item/block identities across active sessions. At
saturation it conservatively redacts subsequent events for affected computer-enabled
threads until session release, rather than forgetting an identity and leaking late results.
Before queue admission, both adapters store bounded computer screenshots through the
attachment registry and enqueue only sanitized summaries and attachment references.
Missing storage, unknown threads, plan mode, or exhausted image budgets produce an
omitted count. Queued references survive session/provenance disposal. Central ingestion
keeps these references when creating activities and still extracts other MCP images.

## Chrome integrations and native-host transactions

Claude in Chrome and Codex's bundled Chrome plugin remain **uncertified**. Claude is
launched with `--no-chrome`, user overrides are stripped, and built-in Chrome calls remain
denied. No native-host registration is changed by this build.

`chromeSessionRuntime.ts` connects the shared inspection/transaction primitives to
Claude's SDK launch, the mandatory pre-tool hook, trusted desktop setup consent and
main's Chrome lease. Both the descriptor registry and main's platform/provider gates
must certify an installed executable before `--chrome` can be selected. The descriptor
pins its executable hash, browser roots, native-host names, expected profile target,
server provenance verifier and evidence. User launch flags cannot bypass this decision.

Setup consent names the previous and proposed host paths and travels only over the
private host channel. After consent F5 rechecks registration hashes before launch and
records post-launch changes, including safely recognized changes from a partial launch.
Every call rechecks the main-owned lease, pause, live policy and registration drift;
approval waits recheck them again. A failed or unverifiable server is denied for the
session and changes its next-turn restart fingerprint. The lease survives until the
CLI exits. The first release conservatively excludes **all** native input while a
Chrome session holds the lease, rather than allowing concurrent input in other apps.
Chrome admission also requires a healthy native helper/device lock and a registered
emergency shortcut. Other profiles receive only anonymous lease ownership.

`chromeNativeHostStorage.ts` persists transactions atomically under server-owned
`claude-chrome/transactions/` and `codex-chrome/transactions/` directories, with bounded
reads and UUID/provider/profile identity checks. These files are not settings. Settings
shows setup history for initialized certified runtimes. Restore stops the profile's
Chrome sessions, reserves the machine lease, and restores only registrations whose
post-launch hashes still match; externally changed entries are reported as skipped.
File restoration is atomic. Windows restoration checks the certified registry key/view,
restores the original manifest bytes and original default value, or deletes only an
originally absent registration. OS-specific restoration and discovery still require the
recorded machine tests. Runtime initialization after restart requires a matching
certified installed version before its restoration history becomes available.

The shared coordinator supports both provider descriptors, but Codex's plugin launch
and pre-execution veto bridge remain unavailable until a supported isolated runtime is
identified and certified. No descriptor is fabricated for either provider. These code
paths do not enable an integration while the gates remain closed.

## Certification and validation

No signed-build certification is claimed. Native platform flags, provider built-in
records and Chrome descriptors remain closed until the tests below pass. Hosted CI and
unit tests do not establish TCC attribution, consent integrity, capture isolation or real
stop latency. Record build hash, OS/arch, helper signature/team, permission identity,
provider/installed version, app/action matrix, measurements and proving artifacts.

| Original release requirement                             | Required signed-machine proof                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Per-app consent cannot be widened by the agent        | Trusted user consent, blocked/F5 rejection, web-only read-only card, incarnation mismatch, grant/revoke/forget and restart checks                  |
| 2. Stop input in under 100 ms                            | Key-logging test app under sustained input; repeat with renderer hung and backend stopped; chords must not trigger system actions                  |
| 3. Input never reaches F5/system dialogs                 | Mid-type focus/dialog changes, protected password fields, cross-F5 drag, terminal without typing, elevated Windows owner and semantic action tests |
| 4. Ungranted/F5 content never appears in captures        | Moving windows, notifications, Dock/Start/tray, packaged Windows apps, secure fields and overlays on both monitors/fullscreen Spaces               |
| 5. Permission failures are surfaced without silent retry | Revoke Accessibility/Screen Recording, SCK decline, periodic re-prompt and helper/main attribution mismatch                                        |
| Signed packaging                                         | Universal macOS helper signature/notarization and Windows signature verification; installed helper path confined to resources                      |

Run each provider through TextEdit/Notepad, Preview/Calculator, an Electron semantic
workflow and a multi-app workflow. Include mixed-DPI monitors, rotation/negative origins,
physical-input pause/resume with fresh geometry, multiple profiles, dev+packaged contention,
monitor loss, permit expiry and control with all macOS F5 windows closed. Benchmark Windows
include-only composition on 50 windows (target <150 ms release build).

Built-ins additionally require recorded enablement, user consent, F5 pre-call veto, stop
behavior, targetability of F5/blocked apps, screenshot scaling (Claude), and Codex plugin
reads/writes under its configured `CODEX_HOME`. No provider credential/state from another
F5 profile may be accessed. Publish the weaker guarantees in the table above alongside
actual measurements. Chrome certification must record all registration changes,
concurrency behavior, successful calls, live policy/pause denial and byte-for-byte restore.

Repository gates: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test:full` and
`bun run test:desktop-smoke`. Never use `bun test`. Native checks are `swift test`,
`cargo test`, generated-tier drift and helper hello/permissions protocol checks. Live
provider tests are opt-in and consume account quota; they do not replace signed-machine
certification. Existing preview broker regression tests remain unchanged.

`integration/computerMcp.test.ts` exercises the authenticated HTTP catalog against a
controlled IPC host: catalog discovery, app consent, a model-readable image block, action
authorization, session-action approval, pause rejection and credential cleanup. The opt-in
`claudeComputerMcp.live.test.ts` and `codexComputerMcp.live.test.ts` add real provider tool
discovery and image/action transport. Their host simulates an app and does **not** inject
OS input; signed-machine actions and the isolation/latency checks still need the manual
matrix above. Codex records additional approval methods and rejects unexpected requests.

## Review follow-up and remaining release work

Native policy tests now exercise both tier tables, blocked chords, interrupted input,
held-input release, device-lock contention, window recipient exclusions and independent
hook failure. They do not replace real OS recipient/capture tests, the complete planned
native authorization matrix, Windows execution or signed-machine certification.
Native tests now call the same focus, owner, secure-element, chord and menu-region
policies as the helpers. Windows composition tests exercise the actual pixel cropping
and alpha composition used by capture, including invisible borders and negative origins.
Claude Chrome launch/consent/lease/veto/restore consumers are connected behind empty
certification records. Provider built-in launch bridges and Codex Chrome plugin wiring
remain unavailable for the integration constraints above. No native, built-in or Chrome
release gate was enabled by this work.

Transport admission joins concurrent retries by MCP request identity and retains completed
IDs as tombstones. A late retry gets `ReplayRejected` rather than repeating input.
Post-action captures can return `screenshotError` alongside `actionCompleted: true`; a
failed capture does not turn a delivered action into an input failure. Positive vertical
scroll deltas mean down, and positive horizontal deltas mean right. Ambiguous app queries
return candidate identities instead of adding every match to a default-selected card.

The Codex process-liveness guards are required to keep retired process events from
changing a replacement session and its computer authority. The Claude rejected-resume
fix is broader than computer use: the existing “reports the first turn after a rejected
resume point as not sent” regression requires `deliveryRetryable: false`, so a rejected
resume cannot trigger an automatic resend. It remains included as an explicitly identified
prerequisite bug fix and is covered by that adapter test, including sessions with computer
use disabled.

To collect a preflight without granting access or injecting input, run:

```sh
bun scripts/record-computer-certification.ts --app /Applications/F5.app --output /tmp/f5-certification.json --build-commit <installed-build-commit>
```

For a development binary use `--helper <path>` instead of `--app`. The recorder hashes
and verifies signatures, starts the helper suspended and observes permissions only.
It refuses to overwrite a report and leaves every machine-test item pending with
`certified: false`. It records repository and installed-build commits separately; a
preflight never proves TCC identity, real capture isolation or input-stop latency.

The unsigned macOS rehearsal controls two temporary AppKit test apps containing only
synthetic data. It grants no existing user app, starts a fresh permit, stops on physical
input without resuming automatically, and closes its own app/helper at exit:

```sh
bun apps/desktop/src/computer/rehearseHelperMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --output /tmp/f5-native-rehearsal.json
```

It exercises real app activation, accessibility inspection, semantic pressing, secure
field refusal, grant revocation, display-space clicking, Unicode typing, protected chords
and permit expiry. It verifies that a second helper with a different `HOME` shares the
OS user's device lock. Capture checks first show both synthetic color markers when
both apps are granted, then revoke the second app and verify its marker disappears.
They also check secure-field masking in JPEG captures and PNG zoom, and additional
Retina zoom detail. Images are decoded and checked in memory by the fixture verifier.
The report keeps outcome codes and timings; no typed values,
accessibility content or screenshots are saved. A protected pointer refusal remains a
failed check; only the independent permit-expiry refusal check continues afterward. Physical input ends the rehearsal without resuming.
Failed or skipped checks are not certification evidence.
Signing is deferred for this development work. Capture masking across the real-app
matrix, physical kill-chord latency, provider turns through the full Electron desktop,
renderer/backend failures, multiple profiles, overlays,
Windows runtime and installed-build TCC attribution still need recorded machine tests.

A separate opt-in rehearsal connects real Claude/Codex turns to the production
`ComputerHostChannel`, `ComputerController`, lease authority, helper client and native
helper through inherited process IPC. It creates a fresh synthetic AppKit app for each
provider and independently observes one button press and the expected Unicode typing
inside that app. No existing user app receives a grant. Scripted consent permits only
the exact fixture identity, rejects mixed-app requests and never remembers a grant.
It exercises the broker's session-actions approval separately from app access.

```sh
F5_COMPUTER_PROVIDER_REHEARSAL=1 bun apps/desktop/src/computer/rehearseProviderMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --provider both --output /tmp/f5-provider-native-rehearsal.json
```

Select the profile's Claude credential directory with `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, both pointing to that profile's `.claude` directory.
For Codex set `CODEX_BINARY_PATH` and `F5_CODEX_CERTIFICATION_HOME` (or `CODEX_HOME`).
The worker preserves the real macOS login home/name for Claude's keychain lookup.
Codex uses a temporary home containing only a private copy of that selected account's
credential, disables plugins and denies command/filesystem approval requests. The
worker accepts an additional MCP consent once only when it names the exact
authenticated F5 computer catalog created by that worker and its form is representable;
commands, unknown servers, URL prompts and unrepresented fields are denied. The
temporary home is removed on success, failure or interruption. The test consumes
provider quota and foreground input; leave the mouse and keyboard idle. Physical input
stops the worker and input authority; a fresh run needs explicit user coordination.
Reports refuse overwrite, retain only operation names, booleans, timing and build
metadata, and never include images, accessibility content, typed values or provider
error details. Capture, nonempty accessible inspection of the fixture, and input must
have valid successful native responses correlated to their request IDs; dispatch and
normal turn completion alone cannot pass. Failed, interrupted and incomplete turns
cannot pass. Earlier provider evidence without these response checks proves dispatch
and independently observed app delivery only; capture/inspection response validation
requires a new coordinated run of the strengthened harness.

This harness deliberately omits Electron renderer windows and real overlays. Its
scripted fixture consent does not certify the trusted consent dialog. Provider calls
through this harness do not prove installed-build attribution, physical kill-chord
latency, the real-app workflow/capture matrix, multiple profiles/displays or Windows
desktop behavior, and never open a release gate.

The first real run exposed a macOS transport defect: `FileHandle.read(upToCount:)` waited
for a full pipe buffer, preventing short requests and suspend messages from executing.
The helper now uses an interruptible POSIX read; XCTest verifies a short command arrives
while stdin remains open. The build protocol check requires a correlated suspend
acknowledgement rather than accepting an unsolicited status heartbeat.
For an elevated Windows CI process, a helper may refuse startup and exit cleanly with
`missing-permissions`. The protocol probe accepts only that explicit fail-closed startup
case; it does not claim an interactive round trip or input health. A running helper must
still answer the correlated permissions and suspend requests. Broken-pipe writes, bad
versions, incomplete handshakes and abnormal exits cannot become a successful usable
helper check.

The [2026-10-10 unsigned evidence](computer-certification/2026-10-10-macos-unsigned.json)
records six passed real-app checks after the pipe fix, protected-system-UI refusals during
pointer checks, and a physical-input interruption in a separate run. It also records the
installed plugin versions/hashes and unsupported launch reasons. These results establish
only the listed development observations; the rest of the release matrix remains pending.

The [2026-10-11 idle-Mac evidence](computer-certification/2026-10-11-macos-unsigned.json)
records nine passed checks, now including real Unicode typing, protected-system-chord
refusal and typing refusal in a focused secure field. Coordinate input remains failed:
a Dock-owned layer-20 window spans the display and is the top rectangular candidate at
the synthetic button. The helper retains its protected-system-UI refusal. The independent
permit-expiry check passed afterward without retrying the pointer action or resuming
input. That historical run exits with failure; the pointer failure is addressed by the
later evidence below.

The [2026-10-11 pointer and capture evidence](computer-certification/2026-10-11-macos-pointer-and-capture.json)
records 14 passed native checks after replacing rectangle-based pointer authorization
with [AppKit's actual mouse-down recipient query](<https://developer.apple.com/documentation/appkit/nswindow/windownumber(at:belowwindowwithwindownumber:)>).
The helper initializes AppKit without activation or windows, converts Quartz coordinates
to AppKit global points, and resolves the selected window's owner. Unknown, stale or
unexpected overlay recipients remain blocked. This avoids treating a transparent Dock
rectangle as the click recipient. The device lock now uses the OS account's home,
preventing isolated provider `HOME` values from creating separate locks.

The same evidence records successful live Claude and Codex F5-tool transport tests:
discovery, fixture consent, model-facing image results and an action dispatch. These
tests use a simulated desktop host and emit no OS input. Codex CLI 0.162.1 reported no
additional MCP approval in this full-access run. The Claude test preserves the macOS
login name and real home for keychain lookup while retaining the profile's config dir;
the initial isolated test's authentication failure did not mean the running F5 session
was signed out. Native checks use real OS input in synthetic apps, separately from
these model-backed transport tests. Neither proves the full provider-to-desktop path,
physical stop latency, signed attribution or the Windows/multiple-display matrix.
All release gates remain closed.

The [2026-10-12 real-provider/native evidence](computer-certification/2026-10-12-macos-real-provider-native.json)
records successful Claude and Codex turns through the production private host channel,
broker, controller, lease authority and native helper. Each provider received access to
one temporary AppKit fixture, took a native screenshot, inspected its real accessibility
tree, pressed its button once and typed the expected Unicode text. The fixture itself
reported receipt independently of the model's response. Both workers released their
turn lease before exit. Claude's model-facing native image block was directly observed.
Codex CLI 0.162.1, in approval-required mode, issued five additional MCP approval prompts;
each was accepted once for the exact test catalog. An earlier denied-prompt run delivered
no input. A separate physical-input attempt interrupted the worker without auto-resume.
All 14 native-helper checks passed again after sharing the fixture launcher.

These observations replace the earlier simulated-host limitation for this narrow
provider-to-native-controller path. The harness uses scripted fixture consent and no
Electron renderer or real overlay windows; it does not certify the complete desktop
experience, physical kill-chord latency, real-app/multi-display/multi-profile matrix,
Windows desktop behavior or installed-build permission attribution. Signing remains
deferred, and every release gate stays closed.

The [2026-10-12 correlated-response evidence](computer-certification/2026-10-12-macos-provider-correlated-results.json)
records a fresh passing run for both providers after strengthening the rehearsal's
result checks. Both received valid successful native capture responses, nonempty
accessible inspection of their exact fixture, and successful input responses matched
by request ID. Each fixture independently observed exactly one press and the expected
Unicode text, and both workers released their leases. Claude's model-facing image was
observed again; Codex issued five catalog-specific approvals, all accepted once.
This replaces the historical dispatch-only limitation for these narrow response checks.
Scripted consent, the absence of real Electron UI/overlays and the other release
certification limitations still apply; no release gate is opened.

The human-assisted physical-stop rehearsal observes only event timings inside a
temporary synthetic AppKit window. The helper reports its monotonic recognition time
before releasing held input; the fixture records native event-creation and app-delivery
times without reading characters or logging physical key codes. A passing run requires
active synthetic typing, both physical input and the complete kill chord, a quiet tail,
interrupted input, refusal of further typing and a released lease. Missing traces,
clock mismatches, overflow and timing uncertainty fail the check.

```sh
F5_COMPUTER_STOP_REHEARSAL=1 bun apps/desktop/src/computer/rehearseStopMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --output /tmp/f5-physical-stop.json
F5_COMPUTER_STOP_REHEARSAL=1 bun apps/desktop/src/computer/rehearseStopMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --output /tmp/f5-frozen-backend-stop.json --freeze-backend
```

Coordinate an idle window with the operator first. Press Control+Command+Escape only
when the fixture turns red and says NOW. Physical input latches pause; the harness never
resumes input. The frozen-backend mode uses the real broker/host IPC classes, grants only
its own fixture, SIGSTOPs that worker during typing, verifies its stopped OS process
state before and after the chord, then SIGCONTs it only for cleanup. It uses no provider
account/quota. A separate `--stall-host` mode blocks the test supervisor for 700 ms.
In this mode the countdown holds before red; the supervisor first waits for a fresh
heartbeat, flushes the red-cue command, and immediately blocks. This avoids prompting
the operator while a heartbeat wait still delays the stall. Clock offset bounds come
from a native-fixture round trip; both recognition events must
fall conservatively inside that interval, otherwise the stalled-host check fails.
Execution permits retain the production one-second expiry and 250 ms renewal cadence.
No renderer or real overlay is launched in either mode.

The [2026-10-12 physical-stop evidence](computer-certification/2026-10-12-macos-physical-stop.json)
records a passed responsive-host run (0 ms input-emission tail, 0.4 ms delivery tail)
and a passed frozen-broker-backend run (no recorded synthetic event created or delivered
after recognition). A zero tail means the last synthetic event preceded recognition;
it is not an exact zero-time cancellation measurement. Both runs observed the full chord,
interrupted the action, refused further typing and released the lease. The operator
reported no system action during the first two attempts. The three supervisor-stall
attempts stayed below 100 ms for stopping input but **failed** timing/arming coverage,
so they do not certify a stalled supervisor. The revised heartbeat-before-red sequence
was retried with a 6.9 ms delivery tail but still failed interval coverage; this is
recorded in the [cue-fix attempt](computer-certification/2026-10-12-macos-stalled-cue-attempt.json).
Later reports include conservative relative recognition offsets from the stall start/end
to distinguish early, late and clock-uncertain triggers. No absolute uptime or raw input
trace is saved, and the historical failures remain unchanged.
Signed installed-build attribution, real
Electron renderer/backend failures, Windows and the full release matrix remain pending.
No gate is opened by this unsigned evidence.

### Real Electron rehearsal

The opt-in Electron rehearsal launches the compiled F5 main, preload, renderer and
server with isolated application state. It copies only the selected Codex profile's
authentication file into its temporary private home, disables plugins, creates its own
temporary project, and grants no user app automatically. Build the desktop first:

```sh
bun run build:desktop
F5_COMPUTER_ELECTRON_REHEARSAL=1 bun apps/desktop/scripts/rehearse-computer-electron.mjs --codex-home <selected-profile-home> --codex-binary <codex-binary> --output /tmp/f5-electron-computer.json
```

The same runner accepts `--stop-renderer` or `--stop-main` for separate physical-stop
checks. Both use a timing-only synthetic fixture, the real human app-consent flow,
and a real provider typing call. An external supervisor SIGSTOPs the selected isolated
Electron process, verifies its OS process state, then sends the fixture's red cue.
The renderer mode remains frozen until the chord is observed (at most ten seconds);
the main mode measures a 700 ms freeze, with an independent 850 ms restoration limit.
SIGCONT is also guaranteed on runner cancellation and normal cleanup. The main mode
retains the production permit expiry, so a late human response fails coverage instead
of extending input authorization. Both physical recognition and the complete chord
must fall inside conservative clock bounds for the verified freeze. The checks also
require interrupted typing, a quiet delivery tail, mirrored pause, refusal of a new
typing call, and lease cleanup. No input, grant, permit or consent is injected by the
observation wrapper. Only counts, fixed outcomes and relative timing summaries are
saved; helper/fixture raw data and typed values are discarded. A SIGSTOP test covers
process unresponsiveness, not every possible deadlock. These runs do not open signed
release gates.

The first [real frozen-renderer attempt](computer-certification/2026-10-12-macos-electron-renderer-stop-attempt.json)
records both physical recognition and the full chord during a verified 709.4 ms renderer
freeze. Input emission stopped within 8.2 ms of physical recognition and app delivery
within 12.6 ms; typing was interrupted, pause mirrored and the lease released. The
**overall run failed** in its follow-up verification: the runner looked for the ordinary
Send message control instead of the Send now control shown after turn interruption.
It therefore did not prove refusal of a subsequent mutation or record a frontmost-app
receipt. The runner now handles Send now without resuming computer permission, and the
fixture reports its own frontmost state before subsequent composer interaction. The
original failed report remains unchanged; these fixes alone are not a passing rerun.

Coordinate with the operator before launching. The real consent dialog must be answered
by a human for the single synthetic fixture. The operator then leaves input idle and
follows the window's instructions for Pause and Resume. Turns go through the real
composer and queue admission. The rehearsal checks correlated successful native
responses, fixture receipt, consent settlement, banner and live thumbnail, semantic
outlines, coordinate cursor, explicit resume, a fresh capture and lease/overlay cleanup.
It never auto-answers F5 consent or relaxes the physical-input pause boundary.

Reports distinguish a trusted click, a correlated answer forwarded by main, and server
grant settlement. They retain only booleans, counts, operation/outcome codes, geometry
and build identity. No screenshots, accessibility values, typed values, credentials or
raw errors are saved. Failures remain failures; the temporary window, fixture and state
are cleaned up afterward. This is an unsigned macOS/Codex/synthetic-app rehearsal,
not the signed installed-build or complete real-app certification matrix.

Append `--status-only` for a read-only diagnostic: three provider turns use tool discovery,
`computer_status` and `computer_list_apps`. A pass requires three successful native
metadata responses correlated at the inherited IPC boundary, not merely three completed
model turns. No consent, screenshot or lease is requested. The
[recorded discovery run](computer-certification/2026-10-12-macos-electron-read-only-discovery.json)
observed all three metadata responses with no lease and no recorded provider error.
It proves that narrow observation path, not input or human controls.
A [subsequent diagnostic](computer-certification/2026-10-12-macos-electron-read-only-timeout.json)
timed out with the provider turn still running and no native request. That result remains
failed. The observer now validates metadata response schemas as well as correlation.
Code inspection also found that a correlated computer-tool approval could lose its
request ID, request type and advertised choices during sanitization. The sanitizer now
preserves those control fields, validates decisions and generates fixed choice labels;
provider labels, warning/detail strings and tool contents are removed. Safety presentation
flags remain intact. An ingestion regression verifies the UI receives both the request
and its matching settlement. This fixes an independently demonstrated approval bug;
the earlier diagnostic does not establish it as that run's cause.

The [first recorded Electron consent attempt](computer-certification/2026-10-12-macos-electron-consent.json)
confirmed human consent, main's answer forwarding and server grant settlement, but the
turn completed without native input. That run remains failed; its report does not identify
the subsequent blocker. The [separate consent/action-turn attempt](computer-certification/2026-10-12-macos-electron-actions.json)
confirmed that the grant survived a turn boundary, successful native capture and
inspection, one fixture button press and Unicode typing, and the real lease banner.
It failed at human Pause: the operator reported no visible button. A
[follow-up attempt](computer-certification/2026-10-12-macos-electron-controls-attempt.json)
confirmed Pause was initially visible after correcting lease-release recency, but the
operator could not click it before the 15-second window expired. The live card now
retains controls while the session has approved apps, labelled "Computer access" when
idle. With no grants remaining it retains the 15-second post-release activity window.
This extends the original transient-card design in response to operator feedback; it
keeps Pause and Revoke reachable without widening grants or resuming input.
A recent-input refusal during initial
lease acquisition also publishes its pause to the UI instead of leaving an invisible
latch. Unit and browser regressions cover both control visibility and dialog settlement.
These historical attempts remain failed, and all release gates remain closed.
An [additional pre-action attempt](computer-certification/2026-10-12-macos-electron-no-action-attempt.json)
confirmed consent but completed the action turn without issuing native input. The
rehearsal now explicitly permits tool discovery as well as the F5 catalog; the prior
prompt restriction may have contributed, but the historical report does not establish
that cause. Pre-host diagnostics retain only known error tags from sanitized provider
activities and the latest host availability/reason, never raw provider output.
The [earlier foreground attempt](computer-certification/2026-10-12-macos-electron-consent-timeout.json)
expired waiting for a human answer: no trusted click, forwarded answer, grant or lease
was observed, and no input was emitted. Pause/Resume, the subsequent fresh screenshot
and coordinate-click sequence remain pending in the real Electron workflow.

The [native-consent inspection attempt](computer-certification/2026-10-12-macos-native-consent-inspection-failure.json)
at commit `856ae44523` passed the main-owned native consent dialog, grant settlement,
activation and capture, then failed at `inspect` with `Execution` before any input or
human controls. That report predates safe execution-error classification and does not
identify the cause. A separate
[background inspection diagnostic](computer-certification/2026-10-12-macos-background-inspection.json)
passed at node limits 20, 100 and 400, returning 12 nodes within 30 ms each. The
helper stayed suspended, with no execution permit, capture, activation or input; the
only scripted grant was for the diagnostic's own synthetic app. This does not prove
inspection through Electron or a provider session.

Append `--controls-only` to the Electron command to isolate native consent, persistent
Pause visibility, human Pause/Resume, refusal of an untrusted resume, fresh capture and
lease/overlay cleanup. This mode activates and captures the fixture but issues no
inspection, pointer/keyboard or semantic actions. The
[recorded controls run](computer-certification/2026-10-12-macos-native-controls.json)
passed all those checks and submitted all three turns through the real composer.
It still **failed overall** because the combined activity/thumbnail push check and
thumbnail rendering failed. That aggregate result does not identify which push was
absent. Those checks remain required, since app activation is a
mutation. The transport regression exercises private IPC through the real server push
bus to a WebSocket client; the rehearsal now counts IPC activity and action captures
separately, retaining no content, to locate the outstanding failure.

Append `--actions-only` instead to investigate the full inspection, semantic input,
Unicode typing and coordinate workflow without repeating human Pause/Resume. The
operator approves the native fixture dialog and stays idle through the action turns;
this mode does not claim controls evidence. The three diagnostic modes are mutually
exclusive. Exact known F5 execution messages map to fixed codes; unknown details are
discarded. Neither a completed model turn nor an action with a failed follow-up capture
is treated as proof of that capture.

The [actions-only trace](computer-certification/2026-10-12-macos-native-actions-trace.json)
then passed native consent, capture, inspection, semantic press/focus, Unicode typing,
the next-turn coordinate click, semantic and coordinate overlays, and lease cleanup.
It observed 12 IPC activity events and one thumbnail reaching the renderer, but still
**failed overall** because the live-card image was absent at the end. The store replaced
each action with the next one, discarding a previous thumbnail when later actions
provided no screenshot. The live card now retains a separately labelled last capture
while displaying the latest action. Grant changes, backend changes and reconnects
discard that capture; the earlier image is never attached to a later action. Store and
browser regressions exercise this sequence and revocation. The earlier inspection
failure remains unexplained; a later successful observation does not retroactively
turn that failed report into a pass. The failed reports remain part of the evidence.
The [corrected-renderer attempt](computer-certification/2026-10-12-macos-corrected-renderer-pre-input-failure.json)
at `073e4ccb60` passed native consent, activation, capture and inspection, but stopped
before any semantic or keyboard input reached the helper. Its last observed request
was app resolution, with no tagged helper failure. It did not reach thumbnail validation
and remains failed; it does not establish why the agent stopped. The shared tool
boundary now publishes fixed, session-scoped outcome codes for failed calls, including
failures before native dispatch, without names, input values or raw error text. Unknown
details remain discarded and model-facing errors remain intact. The rehearsal captures
those ephemeral WebSocket codes separately from native IPC outcomes. Prompts explicitly
use the exact app ID in every app argument and request post-activation captures instead
of leaving those choices to the model. These changes improve reproducibility and
diagnosis; they do not retroactively identify this attempt's cause or weaken any check.
The [instrumented attempt](computer-certification/2026-10-12-macos-instrumented-pre-type-failure.json)
at `daa20cec52` observed successful capture, inspection and two semantic-action
responses and emitted one thumbnail. It then ended without a typing request or a tagged tool failure, so it
remains failed. Inspection of the access result found a misleading representation:
full-tier grants permit typing, but their stored `allowTyping` flag is false because
that flag is only an extra click-tier permission. Access results now report derived
`typingAllowed`, using the existing authorization predicate, and tool descriptions
explain the distinction. Stored grants, helper authorization, click-tier consent and
secure-field protections are unchanged. A regression confirms a full-tier grant reports
effective typing permission without changing its stored flag or opening another consent
request. This is a demonstrated presentation defect, not proof of why that model turn
stopped. Future failed runs also record content-free thumbnail visibility/load booleans
at cleanup, separately from the overall workflow checks.

The [passing Electron actions run](computer-certification/2026-10-12-macos-electron-actions-passed.json)
at `31d4458d19` then passed all 18 actions-only checks through the real composer,
provider, main and helper. Native human consent settled once; successful capture,
inspection, semantic press/focus and Unicode typing were correlated; a subsequent
turn took a fresh capture and delivered the coordinate click. The fixture independently
reported two presses and receipt of the expected synthetic text. Twelve activity events
and four thumbnails were observed; the live-card image was visible and loaded. Semantic
outlines, the coordinate cursor and lease/overlay cleanup passed, with no recorded
provider or tool-outcome error. This confirms that narrow unsigned Codex/synthetic-app
workflow on one Retina display, not the complete release matrix. Pause/Resume was
excluded and retains its separate earlier evidence. The earlier failed runs remain
failed, and this later success does not prove their exact causes. Signed installed-build
attribution, real apps, stalled-host/hung-renderer stop latency, multi-profile/display
isolation and Windows runtime still require their own proving runs. Native, provider
built-in and Chrome release gates remain closed; signing remains deferred.

For background inspection without changing focus or starting a provider session:

```sh
bun apps/desktop/src/computer/rehearseInspectMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper --output /tmp/f5-background-inspection.json
```

The [current read-only preflight](computer-certification/2026-10-12-macos-gate-preflight-856ae44523.json)
confirms development permissions on one Retina display. Signing remains deferred;
the native release flags and provider built-in/Chrome certification registries remain
closed. These unsigned results do not establish installed-build TCC attribution,
Windows runtime safety, mixed-display behavior or the complete real-app matrix.

### Build prerequisites and bounded replay state

Desktop development builds attempt the native helper build on macOS and Windows. A
missing development toolchain produces a warning and `helper-missing`; there is no
runtime compilation or download. Release artifacts always build and bundle the helper,
even while certification gates are closed, so the shipped binary and packaging can be
certified. This requirement is intentional.

macOS requires Xcode with the Swift toolchain and macOS SDK. Universal artifacts build
both arm64 and x86_64 slices and combine them with `lipo`. Windows requires Rust, the
requested `x86_64-pc-windows-msvc` or `aarch64-pc-windows-msvc` target, Visual Studio C++
build tools and the Windows SDK. Release builds fail if the required helper cannot be
built. Signing remains a separate release/certification requirement; unsigned rehearsal
results do not open a release gate.

Replay tombstones are retained within their authorization generation, including failed
admissions. They have a fail-closed ceiling of 65,536 per dispatcher/controller. Expiring
them by time would let a delayed request execute again. Session replacement clears the
old session's desktop admissions; lease generation changes clear older admissions. An
observation-only session reaching the ceiling must restart its provider session. An MCP
client reinitialization gets a new `Mcp-Session-Id` and dispatcher; requests using the
retired transport session are rejected. Mutations are never retried automatically.

Consent keeps the approved plan's defaults: grantable apps are selected, typing for
click-tier apps and remembering grants are off. Ambiguous app searches return candidates
without opening a consent card. The user must explicitly allow the displayed selection.
Resume requires a trusted gesture in a local F5 window; remote clients can pause but
cannot re-arm native or Chrome control. The server mirrors resume only after main's
successful acknowledgement.
