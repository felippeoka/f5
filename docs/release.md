# Releasing F5

Every release includes macOS arm64/x64 DMG + ZIP, Windows x64 NSIS, Linux x64 AppImage, and all five CLI archives (darwin-arm64, linux-x64/arm64, win32-x64/arm64). Never publish desktop-only: `f5 install` and `f5 update` use the stable release's `f5-cli-release.json`.

## One-time maintainer setup

Create the `release` environment, allow deployment refs `v*` and `main`, and require reviewer `lopes-felipe`. Store Developer ID Application `.p12` credentials as `CSC_LINK` (base64 or certificate URL) and `CSC_KEY_PASSWORD`. Store the App Store Connect `.p8` key contents as `APPLE_API_KEY`, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Signed macOS builds fail closed when any credential is absent. The workflow writes the key into the runner's temporary directory.

Optional Windows signing secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`. Once available, set repository variable `F5_WINDOWS_SIGNING_REQUIRED=true`; missing credentials then fail builds. Otherwise Windows artifacts are explicitly unsigned.

Apply a tag ruleset restricting create/update/delete of `refs/tags/v*` to admins and enable GitHub release immutability. These repository settings require maintainer setup. Prevent upstream tags entering origin: `git config remote.upstream.tagOpt --no-tags`. Never push all upstream tags.

## Prepare and publish

First public release: `v0.1.0`, rehearsed as `v0.1.0-beta.1` then `v0.1.0-beta.2`.

1. Run `node scripts/prepare-release.ts 0.1.0-beta.1` (or a higher version). It updates four manifests and the lockfile. Stable preparation moves Unreleased into a dated section; beta preparation leaves it untouched. Follow the printed commands to open a release PR.
2. Merge and wait for a successful **CI push** run on main at the exact release SHA.
3. Run `git tag vX.Y.Z <sha>` and `git push origin vX.Y.Z` (use `-beta.N` for beta). Only stable and beta.N tags are accepted. The version must exceed every published stable/beta version.
4. Approve the release environment. The workflow builds, signs, notarizes, checks all hashes/manifests, and creates a **draft**. Updaters cannot see drafts. `workflow_dispatch` with `dry_run=true` on main rehearses builds with a unique dryrun version and creates no release.
5. Smoke-test one installer per OS and both macOS architectures using the checklist below. Inspect `release-bundle`, staged dependency lock artifacts, and the draft's asset names and sizes. Changelog text is the release body; YAML never contains releaseNotes.
6. Publish: `gh release edit <tag> --draft=false`, adding `--latest` for stable. Beta releases remain prereleases.

Published releases are immutable. Fix regressions with a higher patch release; never overwrite assets or enable downgrades. Existing drafts are preserved on retry for inspection. After verifying that an existing release is still a draft and saving anything needed for investigation, the maintainer can remove only that draft with `gh release delete <tag> --yes` (without `--cleanup-tag`), then rerun publication. The tag is retained. Agents do not perform this destructive operation under this repository's Git/GitHub policy.

Beta uses electron-updater 6.8.3's first stable-or-beta release in Atom feed order. Other suffixes are skipped. Stable users resolve `/releases/latest`.

Releases across both channels must increase globally. If a higher beta is already published, choose a stable hotfix version above that beta; a lower stable hotfix is rejected. When a beta branch is still maintained, include stable fixes in its next beta. The provider feed-order test documents why a lower stable release would otherwise hide a higher beta; that publication pattern is not permitted by this policy.

## Release checklist (record results in the PR)

- Dry run on main produces signed/notarized desktops and five CLI archives, passes assembly, and creates no release.
- Publish beta.1 after inspecting its exact asset set. Install without source, Node or Bun on each OS. macOS passes `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl -a -vvv -t execute` with `Notarized Developer ID`.
- Test import with F5 (Alpha) running: launch blocks until it quits; retry imports without changing legacy data. Regrant Screen Recording and Accessibility. Preview sign-ins may need to be repeated because cookie encryption used the old identity.
- Run alongside upstream T3 Code on macOS/Windows; verify separate storage and independent single-instance locks. F5 must block computer use against itself (including dev).
- Missing Git/provider CLI leaves F5 open with diagnostics.
- Publish beta.2; check, download, restart on mac arm64/x64, Windows, and AppImage. Test confirmation cancel, window-close veto, offline check, and interrupted download. On a slow Mac, allow Squirrel staging to take more than 60 seconds: windows and agents must stay running until staging completes, with no watchdog recovery or duplicate quit. macOS native staging/handoff is uncancellable and has no timer-based recovery; native errors still allow retry. Windows and Linux retain the 60-second watchdog.
- Launch from a mounted DMG: Move to Applications works; Not Now leaves updates disabled with an explanation in About.
- Publish stable; beta installs update and retain beta preferences. Stable installs never see betas. Turning beta off never downgrades.
- Verify `f5 install` and `f5 update` with the stable CLI manifest.
- After stable publication, fetch `https://github.com/lopes-felipe/f5/releases/latest/download/latest-mac.yml`, `/f5-cli-release.json`, and one installer under the same base URL; each must return 200 and the expected version.
- Confirm the global monotonicity check rejects a lower stable release when a higher beta exists. Automated provider tests also document that unsupported feed order.

Apple credentials, the release environment, and tag ruleset are prerequisites for publication. Local tests cannot substitute for the signed multi-OS rehearsal.
