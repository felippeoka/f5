# Install F5

Download installers from [GitHub Releases](https://github.com/lopes-felipe/f5/releases/latest). F5 bundles its backend runtime; Node, Bun and a source checkout are unnecessary. Git and your chosen provider CLI are separate prerequisites for using agents; diagnostics remain available if either is missing.

Current availability: Windows x64 is the first stable desktop platform, starting with `v0.1.0`, with in-app updates. If the latest release lists no `F5-<version>-x64.exe`, that first Windows release has not been published yet. macOS Apple Silicon has only the computer use preview below. macOS Intel and Linux desktop builds are not yet available. The `f5` CLI ships for all five targets in every release.

## macOS

No stable macOS release exists yet. The [`v0.0.11-computer-use-preview.1`](https://github.com/lopes-felipe/f5/releases/tag/v0.0.11-computer-use-preview.1) preview is Apple Silicon only, unsigned and not notarized, does not update automatically, and replaces F5 (Alpha); follow its release notes. Once stable macOS releases ship, they will use Developer ID signing and notarization: choose arm64 for Apple Silicon or x64 for Intel, open the DMG, drag F5 to Applications, eject the disk, then open F5 from Applications. Grant Screen Recording and Accessibility when prompted. If launched from a mounted disk or App Translocation, choose Move to Applications to enable updates.

## Windows

Run the x64 installer (`F5-<version>-x64.exe`). It installs for your user without administrator privileges and adds a Start-menu shortcut. Windows on ARM is not supported by a native build.

The installer and application are **not code-signed** yet:

- SmartScreen may show "Windows protected your PC" with an unknown publisher. Choose **More info → Run anyway** only after verifying the download. Signing alone also does not guarantee immediate SmartScreen reputation ([Microsoft guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- Windows 11 Smart App Control in enforcement mode blocks unsigned applications, with no per-app override. F5 cannot be installed there until signed releases ship.
- Organisation policies (WDAC/App Control, AppLocker, or antivirus rules) may also block unsigned applications.

Verify the installer before running it: compare `Get-FileHash F5-<version>-x64.exe -Algorithm SHA256` with the matching line in the release's `SHA256SUMS`.

Updates install in place through Settings → About. A later signed release updates unsigned installations normally; from then on, F5 verifies that each update is signed by the same publisher.

## Linux

No desktop build is available yet. Once AppImage releases ship: download the x64 AppImage, make it executable (`chmod +x F5-*.AppImage`), and open it. Keep the AppImage somewhere writable for updates. Your distribution may require FUSE support for AppImages.

## Upgrade from F5 (Alpha)

The unsigned `v0.0.11-computer-use-preview.1` preview does not support an in-place update. Quit F5 (Alpha) and T3 Code, delete `F5 (Alpha).app` on macOS, then install and launch F5. The first launch copies Chromium settings from `T3 Code (Alpha)` (or `t3code` if absent) into the new `f5` directory. The legacy directory is preserved. CacheStorage, service-worker script caches, and blob caches are excluded from the copy and disk-space estimate. A large first import still runs before Chromium starts and can take time; wait for it to finish. Backend data under `~/.f5` is untouched.

On Windows, the new app identity installs alongside F5 (Alpha). Quit the old application, install and launch F5 to import settings, and verify your data before uninstalling F5 (Alpha) from Settings → Apps → Installed apps. Keep the legacy settings directory until the import is verified. Always use the new F5 Start-menu entry afterward.

Screen Recording and Accessibility must be granted again. On macOS and Linux, preview-browser sign-ins may need to be redone: Chromium Safe Storage uses the application name in Keychain/libsecret, and F5 does not copy that secret across identities. The profile copy preserves localStorage and IndexedDB but does not promise decryptable cookies. Windows also copies `Local State`, which contains its encrypted profile key. F5 and upstream T3 Code can run independently after import.

An existing nonempty `f5` Chromium profile is preserved even if it has no migration marker. An empty folder (or one containing only `.DS_Store`, `Thumbs.db`, or `desktop.ini`) pre-created by Electron is eligible for import; F5 never replaces a populated profile solely because a marker is missing.

If import fails, quit the legacy app and retry. Make sure there is enough disk space for another copy plus 64 MiB. Support escape hatch: launch once with `F5_SKIP_USERDATA_IMPORT=1` to create an empty F5 Chromium profile. This writes a `skipped` marker and does not remove backend data or legacy settings.

Migration coordination uses `<appDataBase>/f5.migration.lock` (or `f5-dev.migration.lock` in development). The base is `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and `$XDG_CONFIG_HOME` (or `~/.config`) on Linux. F5 reclaims dead owners, records from before the current boot, and incomplete records after a five-second publication grace period. A live owner is never expired solely by age. If a lock still blocks launch, quit every F5 instance before inspecting it; preserve legacy and target settings, and remove only the confirmed abandoned lock if manual support recovery is necessary. The skip-import escape hatch also respects an active import lock.

## Updates

Open Settings → About to check, download, then restart to install. Restart interrupts all windows and running agents, with confirmation. Beta updates are opt-in (and on by default for a beta installation). Turning beta off keeps your current version until a newer stable release ships; F5 never downgrades. A beta preference survives installing a stable build. Release notes appear with available updates.
