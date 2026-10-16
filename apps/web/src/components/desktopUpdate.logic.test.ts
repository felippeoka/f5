import { describe, expect, it } from "vitest";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import {
  getDesktopUpdateStatusSummary,
  resolveAboutUpdateAction,
  isAboutUpdateActionDisabled,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseNotes,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  channel: "stable",
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("returns only non-empty sanitized release notes", () => {
    expect(getDesktopUpdateReleaseNotes({ ...baseState, releaseNotes: "  Fixed things  " })).toBe(
      "Fixed things",
    );
    expect(getDesktopUpdateReleaseNotes({ ...baseState, releaseNotes: "   " })).toBeNull();
    expect(getDesktopUpdateReleaseNotes(baseState)).toBeNull();
  });

  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("shows Retry for check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("check");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("toasts only for accepted incomplete actions", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: baseState,
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: baseState,
      }),
    ).toBe(false);
  });

  it("highlights only actionable updater errors", () => {
    expect(
      shouldHighlightDesktopUpdateError({
        ...baseState,
        status: "error",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe(true);
    expect(
      shouldHighlightDesktopUpdateError({
        ...baseState,
        status: "error",
        errorContext: "check",
        canRetry: true,
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });
});

describe("About update summaries", () => {
  it.each([
    ["disabled", "Disabled"],
    ["idle", "Not checked yet"],
    ["checking", "Checking for updates…"],
    ["up-to-date", "F5 is up to date · checked just now"],
    ["available", "Version 2.0.0 is available"],
    ["downloading", "Downloading 2.0.0… 50%"],
    ["downloaded", "Version 2.0.0 is ready to install"],
    ["error", "Disabled"],
  ] as const)("summarizes %s", (status, expected) => {
    expect(
      getDesktopUpdateStatusSummary(
        {
          ...baseState,
          status,
          availableVersion: "2.0.0",
          downloadedVersion: "2.0.0",
          downloadPercent: 50,
          message: "Disabled",
          checkedAt: "2026-10-16T00:00:00Z",
        },
        Date.parse("2026-10-16T00:00:01Z"),
      ),
    ).toBe(expected);
  });
  it.each([
    ["disabled", "none"],
    ["idle", "check"],
    ["checking", "busy"],
    ["up-to-date", "check"],
    ["available", "download"],
    ["downloading", "busy"],
    ["downloaded", "install"],
    ["error", "check"],
  ] as const)("maps %s to %s", (status, action) => {
    const state = { ...baseState, status };
    expect(resolveAboutUpdateAction(state)).toBe(action);
    expect(isAboutUpdateActionDisabled(state)).toBe(action === "none" || action === "busy");
  });
});
it("keeps background check failures out of the sidebar and avoids duplicate punctuation", () => {
  const state = {
    ...baseState,
    status: "error" as const,
    canRetry: false,
    errorContext: "check" as const,
    message: "Update information is unavailable. Try again later.",
  };
  expect(shouldShowDesktopUpdateButton(state)).toBe(false);
  expect(resolveAboutUpdateAction(state)).toBe("check");
  expect(getDesktopUpdateButtonTooltip({ ...state, canRetry: true })).not.toContain("..");
});
it("shows a disabled preparation action while Squirrel stages the update", () => {
  const state = { ...baseState, status: "preparing" as const };
  expect(getDesktopUpdateStatusSummary(state)).toBe("Preparing update…");
  expect(resolveAboutUpdateAction(state)).toBe("busy");
  expect(isAboutUpdateActionDisabled(state)).toBe(true);
});
