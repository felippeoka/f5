# Agent browser and computer use

Let Claude and Codex open, read and click through pages in F5's preview browser. On macOS they
can optionally control other apps too. Both are off until you turn them on, and you can take
control back at any time.

![Settings → Browser & Computer with agent browser access and computer use toggles](../images/settings-browser.webp)

## How to

1. Open **Settings → Browser & Computer** and turn on **Agent browser access**.
2. Optionally, list the external sites the agent may visit under **Allowed external sites**.
3. Start a new Claude or Codex turn and ask the agent to check a page. F5 opens a **Preview** tab
   without taking focus.
4. Click **Take over** to pause the agent and drive the page yourself.

You can also set each option per project in **Project settings**.

## What the agent can do

Looking at the page never asks for permission: status, snapshots, screenshots and waiting for
text. Clicks, typing and navigation follow the thread's [runtime mode](../runtime-modes.md), and
one "allow for session" approval covers all of them. Screenshots the agent takes show up in the
chat as attachments.

Read-only workflow stages can look at pages but not save screenshots.

## External sites

Local pages (`localhost`, `127.0.0.1`) are always allowed. Anything else must be on your list,
one entry per line:

| Entry                   | Allows                                     |
| ----------------------- | ------------------------------------------ |
| `example.com`           | That host over HTTPS                       |
| `*.example.com`         | Its HTTPS subdomains                       |
| `http://intranet.local` | One host over plain HTTP                   |
| `*`                     | Any DNS host over HTTPS, after you confirm |

Blocked navigations fail the agent's action instead of opening your browser. Sign-in popups stay
with you.

## Computer use (macOS preview)

On macOS 14 or later, the agent can also see and control apps you approve:

1. In **Settings → Browser & Computer**, turn on **Agent browser access** and **Computer use (preview)**.
2. Grant **Screen Recording** and **Accessibility** to F5 in System Settings.
3. Start a new turn. When the agent asks for an app, approve it in F5's dialog.

Any input from you pauses the agent. Press **⌃⌘Esc** to stop it. While paused, the agent can't
take screenshots or inspect apps either.

## Good to know

> [!WARNING]
> Computer use is an uncertified, opt-in preview. Windows, the providers' own built-in computer
> control and the Chrome integrations are not available.

- Turning off **Agent browser access** stops automation on the next tool call, even for agents
  already running.
- A checked-in `f5.json` can never turn on external sites, Claude in Chrome or computer use.
- After you restart F5, app approvals have to be granted again.
- **Screenshot password masking** defaults to **Fast — best effort**. It searches browser
  accessibility for password fields and masks those it finds. Password fields Chrome omits from
  accessibility search may appear in screenshots sent to your model.
- Choose **Conservative — inspect the full tree** to use the full accessibility walk. Large pages
  can hit audit limits and have their entire web area grayed out. The setting applies to every
  project in the current profile and takes effect without restarting F5.
- Both modes mask regions that cannot be audited and preserve app approvals, hidden-app filtering
  and secure-input restrictions. A completed audit means the accessibility calls finished; it does
  not prove every visually present password field was exposed.
- Selectable masking requires an updated macOS helper. Older helpers and other platforms keep
  their existing behavior; captures without mode metadata are labeled **Legacy / unknown**.
- You'll be asked to confirm before closing a tab an agent opened.

<details>
<summary>Details and limits</summary>

| Topic            | Detail                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview hosts    | At most 2 headless previews pinned of 4 instances; a pin is released when you close it or after 10 minutes without agent activity                               |
| Action queue     | Per thread, first in first out, up to 32 queued actions; **Take over** stops the running action at its next checkpoint and fails the queued ones                |
| Snapshot size    | Images up to 2,560 px and 8 MiB; structured data trimmed to 256 KiB; whole response up to 16 MiB                                                                |
| Diagnostics      | Last 50 console messages, navigations, failed loads and the tab's action timeline                                                                               |
| Chat screenshots | PNG, JPEG or WebP, 8 MiB each; one per tool call and 200 per thread                                                                                             |
| Allowlist rules  | IP literals never match wildcards. Ports, paths, credentials and other schemes are rejected                                                                     |
| Page scripts     | The agent can run JavaScript only on local pages                                                                                                                |
| Approvals        | Kept in memory by the desktop app; editing `computer-access.json` cannot create one. Revoking a session also invalidates its approval                           |
| Sandbox          | Agent processes on macOS can't reach Apple Events, synthesized input, screen capture or accessibility directly. All GUI control goes through F5's approval flow |

</details>

## Related

- [Preview browser](preview-browser.md)
- [Runtime modes](../runtime-modes.md)
- [Agent browser technical reference](../agent-browser.md) (contributors)
