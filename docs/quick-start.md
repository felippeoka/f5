# Quick start

> Contributors: commands for developing, building and packaging F5 from source.

There are three ways to run F5:

- **Desktop app:** download an installer; no source checkout, Bun or Node needed. See
  [Install F5](install.md).
- **Standalone CLI:** download a CLI release archive and run `f5 serve` to use F5 in a
  browser. See [Standalone F5 CLI](user/standalone-cli.md).
- **From source:** the recipes below, for development and local builds.

## From source

Run `bun install --frozen-lockfile` from the repository root once after cloning.
The `dev*` and desktop build scripts reinstall automatically when `bun.lock` changes.

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
F5_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Build a Linux x64 AppImage
bun run dist:desktop:linux

# Build a Windows x64 NSIS installer
bun run dist:desktop:win
```

To run the server outside the desktop app without a checkout, use the
[standalone CLI](user/standalone-cli.md) (`f5 install`, then `f5 serve`).

## Updating a source checkout

```bash
git pull --ff-only
bun run start:desktop
```

Pulling source changes does not update `node_modules`. Before building, `build:desktop`
(and therefore `start:desktop`) and the `dev*` scripts compare `bun.lock` with the
lockfile the current installation came from, and check that every declared dependency
is present. If either is out of date they run `bun install --frozen-lockfile` first.
If the install fails, for example because local `package.json` edits no longer match
`bun.lock`, the build stops with bun's error. In CI the check reports missing packages
without installing. `bun run check:dependencies` runs the same presence check without
installing.

## Windows build tools

Workspace scripts invoke the installed JavaScript tools through Node directly.
This avoids relying on the unsigned executable launchers Bun generates in
`node_modules/.bin`, which Windows Application Control can block. Bun may report
that rejection only as `bun: unknown error:` before the build starts.

Keep Node.js (24.13.1 or newer) and Bun on `PATH`, then run the usual commands:

```powershell
bun install --frozen-lockfile
bun run build:desktop
bun run start:desktop
```

Windows security settings do not need to change.
