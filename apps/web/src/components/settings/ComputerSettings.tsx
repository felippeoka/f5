import type {
  ComputerAutomationBackendStatus,
  ComputerBackgroundUnavailableReason,
} from "@t3tools/contracts";
import { useComputerStatus, computerSettingsCanEnable } from "../../hooks/useComputerStatus";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsCard";
const BACKGROUND_UNAVAILABLE: Record<ComputerBackgroundUnavailableReason, string> = {
  "unsupported-platform": "Background control is macOS only.",
  "peer-capability": "This F5 build or helper does not support background control.",
  "preview-off": "Background control is not enabled in this build yet.",
  permissions: "Grant computer control permissions first.",
  "monitor-unhealthy": "The input monitor is unavailable; restart F5 or retry the helper.",
};
/** Background needs the F5 helper's negotiated capability; built-in backends stay foreground. */
export function backgroundUnavailableReason(
  status: ComputerAutomationBackendStatus | null | undefined,
): string | undefined {
  if (!status) return "Checking…";
  if (!status.available) return BACKGROUND_UNAVAILABLE.permissions;
  if (!status.background) return BACKGROUND_UNAVAILABLE["peer-capability"];
  if (status.background.available) return undefined;
  return BACKGROUND_UNAVAILABLE[status.background.reason ?? "peer-capability"];
}
export function computerExecutionModeDescription(
  mode: "foreground" | "background",
  unavailable: string | undefined,
): string {
  const base =
    "Foreground uses your mouse and keyboard. Background lets each agent act inside one approved app without moving your pointer or focus, using F5 computer control only.";
  if (mode === "background" && unavailable)
    return `${base} Background is selected but unavailable: ${unavailable} Agents get an error until you switch to foreground.`;
  return unavailable && mode === "foreground" ? `${base} ${unavailable}` : base;
}
export function ComputerSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { bridge, status, setStatus, error, setError } = useComputerStatus();
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch(() => setError("Could not update computer control."));
  };
  return (
    <>
      <SettingsRow
        title="Computer use (preview)"
        description="Opt-in macOS preview: let Claude and Codex see and control apps you approve. Signed-build safety certification is pending. Press ⌃⌘Esc to stop; your input pauses control. Project approvals expire when F5 closes. Windows remains unavailable."
        control={
          <Switch
            aria-label="Let agents control this computer"
            checked={settings.enableAgentComputerUse}
            disabled={!settings.enableAgentComputerUse && !computerSettingsCanEnable(status)}
            onCheckedChange={(checked) => updateSettings({ enableAgentComputerUse: checked })}
          />
        }
      />
      <SettingsRow
        title="Computer status"
        description={
          !bridge
            ? "Answer access requests on the computer running F5."
            : !status
              ? "Checking…"
              : status.available
                ? "F5 computer control preview ready"
                : `${status.reason}${status.detail ? `: ${status.detail}` : ""}`
        }
        control={
          status &&
          !status.available &&
          ["helper-crashed", "monitor-unhealthy", "helper-missing"].includes(status.reason) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                run(async () => {
                  await bridge?.retryHelper();
                  const next = await bridge?.status();
                  if (next) setStatus(next);
                })
              }
            >
              Retry
            </Button>
          ) : null
        }
      />
      {status && !status.available && status.reason === "missing-permissions"
        ? status.missing?.map((kind) => (
            <SettingsRow
              key={kind}
              title={kind === "screen-recording" ? "Screen Recording" : "Accessibility"}
              description="Required for computer control."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => run(async () => bridge?.openPermissionSettings(kind))}
                >
                  Open System Settings
                </Button>
              }
            />
          ))
        : null}
      <SettingsRow
        title="Backend"
        description="Claude and Codex use F5 computer control while their built-in consent, veto, and profile isolation gates are awaiting certification."
        control={
          <Select
            value={settings.computerUseBackend}
            onValueChange={(value) => {
              if (value === "auto" || value === "f5") updateSettings({ computerUseBackend: value });
            }}
          >
            <SelectTrigger className="w-64" aria-label="Computer backend">
              <SelectValue>
                {settings.computerUseBackend === "f5" ? "F5 only" : "Automatic"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">Automatic (built-in when available)</SelectItem>
              <SelectItem value="f5">F5 only</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Execution mode"
        description={computerExecutionModeDescription(
          settings.computerUseExecutionMode,
          backgroundUnavailableReason(status),
        )}
        control={
          <Select
            value={settings.computerUseExecutionMode}
            onValueChange={(value) => {
              if (value === "foreground" || value === "background")
                updateSettings({ computerUseExecutionMode: value });
            }}
          >
            <SelectTrigger className="w-64" aria-label="Computer execution mode">
              <SelectValue>
                {settings.computerUseExecutionMode === "background"
                  ? "Background (alongside you)"
                  : "Foreground"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="foreground">Foreground</SelectItem>
              <SelectItem
                value="background"
                disabled={
                  settings.computerUseExecutionMode !== "background" &&
                  backgroundUnavailableReason(status) !== undefined
                }
              >
                Background (alongside you)
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
