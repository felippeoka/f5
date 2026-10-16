import type { DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import {
  resolveAboutUpdateAction,
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
} from "../desktopUpdate.logic";
import { toastManager } from "../ui/toast";

/** Desktop auto-update state and the sidebar's update button behaviour. */
export function useDesktopUpdate() {
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch((error) => {
        console.warn("Failed to fetch the desktop update state", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);
  const tooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";
  const releaseNotes = getDesktopUpdateReleaseNotes(desktopUpdateState);
  const buttonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const buttonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const buttonInteractivityClasses = buttonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const buttonToneClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-success-foreground"
      : desktopUpdateState?.status === "downloading"
        ? "text-info-foreground"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-destructive-foreground motion-safe:animate-pulse"
          : "text-warning-foreground motion-safe:animate-pulse";

  const [channelPending, setChannelPending] = useState(false);
  const runAction = useCallback(
    async (action: "check" | "download" | "install" | "none" | "busy") => {
      const bridge = window.desktopBridge;
      if (!bridge || action === "none" || action === "busy") return;
      try {
        const result =
          action === "check"
            ? await bridge.checkForUpdates?.()
            : action === "download"
              ? await bridge.downloadUpdate()
              : await bridge.installUpdate();
        if (!result) return;
        if (action === "download" && result.completed)
          toastManager.add({
            type: "success",
            title: "Update downloaded",
            description: "Restart the app from the update button to install it.",
          });
        const actionError = getDesktopUpdateActionError(result);
        if (shouldToastDesktopUpdateActionResult(result) && actionError)
          toastManager.add({
            type: "error",
            title: `Could not ${action} update`,
            description: actionError,
          });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not ${action} update`,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [],
  );
  const handleButtonClick = useCallback(() => {
    if (!buttonDisabled) void runAction(buttonAction);
  }, [buttonDisabled, buttonAction, runAction]);
  const handleAboutAction = useCallback(() => {
    if (desktopUpdateState) void runAction(resolveAboutUpdateAction(desktopUpdateState));
  }, [desktopUpdateState, runAction]);
  const setChannel = useCallback(async (channel: DesktopUpdateChannel) => {
    const bridge = window.desktopBridge;
    if (typeof bridge?.setUpdateChannel !== "function") return;
    setChannelPending(true);
    try {
      const result = await bridge.setUpdateChannel(channel);
      if (!result.accepted || !result.completed)
        toastManager.add({
          type: "error",
          title: "Could not change update channel",
          description: result.state.message ?? "Try again.",
        });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not change update channel",
        description: String(error),
      });
    } finally {
      setChannelPending(false);
    }
  }, []);

  return {
    state: desktopUpdateState,
    channelPending,
    setChannel,
    handleAboutAction,
    showButton,
    tooltip,
    releaseNotes,
    buttonDisabled,
    buttonAction,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    buttonInteractivityClasses,
    buttonToneClasses,
    handleButtonClick,
  };
}

export type DesktopUpdateController = ReturnType<typeof useDesktopUpdate>;
