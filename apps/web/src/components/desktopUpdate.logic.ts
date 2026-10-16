import { formatRelativeTimeLabel } from "../lib/relativeTime";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "check" | "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return "install";
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  if (state.status === "error") return "check";
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but F5 is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but F5 is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but F5 is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return `${state.message ?? "Update check failed"}. Click to retry.`;
  }
  return "Update available";
}

export function getDesktopUpdateReleaseNotes(state: DesktopUpdateState | null): string | null {
  if (!state || typeof state.releaseNotes !== "string") return null;
  const notes = state.releaseNotes.trim();
  return notes.length > 0 ? notes : null;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function getDesktopUpdateStatusSummary(
  state: DesktopUpdateState,
  nowMs = Date.now(),
): string {
  switch (state.status) {
    case "disabled":
      return state.message ?? "Updates are disabled.";
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return `F5 is up to date${state.checkedAt ? ` · checked ${formatRelativeTimeLabel(state.checkedAt, nowMs)}` : ""}`;
    case "available":
      return `Version ${state.availableVersion} is available`;
    case "downloading":
      return `Downloading ${state.availableVersion}… ${Math.floor(state.downloadPercent ?? 0)}%`;
    case "downloaded":
      return `Version ${state.downloadedVersion} is ready to install`;
    case "error":
      return state.message ?? "Update check failed.";
  }
}
export function resolveAboutUpdateAction(
  state: DesktopUpdateState,
): "check" | "download" | "install" | "busy" | "none" {
  if (state.status === "disabled") return "none";
  if (state.status === "checking" || state.status === "downloading") return "busy";
  const action = resolveDesktopUpdateButtonAction(state);
  return action === "none" ? "check" : action;
}
export function isAboutUpdateActionDisabled(state: DesktopUpdateState): boolean {
  const action = resolveAboutUpdateAction(state);
  return action === "busy" || action === "none";
}
