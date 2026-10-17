# Install F5

Download installers from [GitHub Releases](https://github.com/lopes-felipe/f5/releases/latest). F5 bundles its backend runtime; Node, Bun and a source checkout are unnecessary. Git and your chosen provider CLI are separate prerequisites for using agents ([provider prerequisites](provider-prerequisites.md)); diagnostics remain available if either is missing.

This page covers the desktop app. To run F5 in a browser without the desktop app, use the [standalone CLI](user/standalone-cli.md). To build from source, see [Quick start](quick-start.md).

## macOS

Choose arm64 for Apple Silicon or x64 for Intel. Open the DMG, drag F5 to Applications, eject the disk, then open F5 from Applications. Official releases use Developer ID signing and notarization. If launched from a mounted disk or App Translocation, choose Move to Applications to enable updates.

## Windows

Run the x64 installer. It installs for your user without administrator privileges and adds a Start-menu shortcut. Until Azure Trusted Signing is configured, SmartScreen may show an unknown publisher warning. Verify the download came from this repository before proceeding.

## Linux

Download the x64 AppImage, make it executable (`chmod +x F5-*.AppImage`), and open it. Keep the AppImage somewhere writable for updates. Your distribution may require FUSE support for AppImages.

## Optional: computer use on macOS

Screen Recording and Accessibility are only needed for the opt-in, uncertified computer use
preview. Grant them in System Settings when you turn that preview on; see
[agent browser and computer use](agent-browser.md).

## Upgrade from F5 (Alpha)

The unsigned `v0.0.11-computer-use-preview.1` preview does not support an in-place update. Quit F5 (Alpha) and T3 Code, delete `F5 (Alpha).app` on macOS, then install and launch F5. The first launch copies Chromium settings from `T3 Code (Alpha)` (or `t3code` if absent) into the new `f5` directory. The legacy directory is preserved. CacheStorage, service-worker script caches, and blob caches are excluded from the copy and disk-space estimate. A large first import still runs before Chromium starts and can take time; wait for it to finish. Backend data under `~/.f5` is untouched.

On Windows, the new app identity installs alongside F5 (Alpha). Quit the old application, install and launch F5 to import settings, and verify your data before uninstalling F5 (Alpha) from Settings → Apps → Installed apps. Keep the legacy settings directory until the import is verified. Always use the new F5 Start-menu entry afterward.

If you use computer use, Screen Recording and Accessibility must be granted again. On macOS and Linux, preview-browser sign-ins may need to be redone: Chromium Safe Storage uses the application name in Keychain/libsecret, and F5 does not copy that secret across identities. The profile copy preserves localStorage and IndexedDB but does not promise decryptable cookies. Windows also copies `Local State`, which contains its encrypted profile key. F5 and upstream T3 Code can run independently after import.

An existing nonempty `f5` Chromium profile is preserved even if it has no migration marker. An empty folder (or one containing only `.DS_Store`, `Thumbs.db`, or `desktop.ini`) pre-created by Electron is eligible for import; F5 never replaces a populated profile solely because a marker is missing.

If import fails, quit the legacy app and retry. Make sure there is enough disk space for another copy plus 64 MiB. Support escape hatch: launch once with `F5_SKIP_USERDATA_IMPORT=1` to create an empty F5 Chromium profile. This writes a `skipped` marker and does not remove backend data or legacy settings.

Migration coordination uses `<appDataBase>/f5.migration.lock` (or `f5-dev.migration.lock` in development). The base is `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and `$XDG_CONFIG_HOME` (or `~/.config`) on Linux. F5 reclaims dead owners, records from before the current boot, and incomplete records after a five-second publication grace period. A live owner is never expired solely by age. If a lock still blocks launch, quit every F5 instance before inspecting it; preserve legacy and target settings, and remove only the confirmed abandoned lock if manual support recovery is necessary. The skip-import escape hatch also respects an active import lock.

## Updates

Open Settings → About to check, download, then restart to install. Restart interrupts all windows and running agents, with confirmation. Beta updates are opt-in (and on by default for a beta installation). Turning beta off keeps your current version until a newer stable release ships; F5 never downgrades. A beta preference survives installing a stable build. Release notes appear with available updates.
