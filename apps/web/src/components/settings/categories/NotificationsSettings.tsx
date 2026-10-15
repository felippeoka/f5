import { unlockThreadNotificationSound } from "../../../threadAttention";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { buildAppSettingsPatch } from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";

export { NOTIFICATIONS_SETTINGS_DESCRIPTORS } from "./NotificationsSettings.descriptors";

const NOTIFICATION_KEYS = [
  "notificationMode",
  "inAppThreadNotifications",
  "showAttentionBadge",
  "enableThreadStatusNotifications",
  "enablePrAttentionNotifications",
] as const;

export function NotificationsSettings() {
  const {
    settings,
    defaults,
    updateSettings,
    notificationPermission,
    notificationPermissionSummary,
    isRequestingNotificationPermission,
    requestNotificationPermission,
  } = useSettingsRouteContext();
  const notificationsEnabled =
    settings.notificationMode.includes("system") || settings.enablePrAttentionNotifications;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">Notifications</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Local browser notifications while F5 is open but not focused.
        </p>
      </div>

      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3">
          In-app thread notifications
          <Switch
            aria-label="In-app thread notifications"
            checked={settings.inAppThreadNotifications}
            onCheckedChange={(checked) =>
              updateSettings({ inAppThreadNotifications: Boolean(checked) })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          Show attention badge
          <Switch
            aria-label="Show attention badge"
            checked={settings.showAttentionBadge}
            onCheckedChange={(checked) => updateSettings({ showAttentionBadge: Boolean(checked) })}
          />
        </label>

        <div className="flex items-center justify-between border-b border-border py-2 last:border-b-0">
          <div>
            <p className="text-sm font-medium text-foreground">Thread status notifications</p>
            <p className="text-xs text-muted-foreground">
              Notify when a thread reaches a sidebar status such as pending approval, awaiting
              input, plan ready, or completed.
            </p>
          </div>
          <Select
            value={settings.notificationMode}
            onValueChange={(value) => {
              if (value === "sound" || value === "system-and-sound")
                unlockThreadNotificationSound();
              if (
                value === "off" ||
                value === "system" ||
                value === "sound" ||
                value === "system-and-sound"
              )
                updateSettings({
                  notificationMode: value,
                  enableThreadStatusNotifications:
                    value === "system" || value === "system-and-sound",
                });
            }}
          >
            <SelectTrigger aria-label="Thread status notifications">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="system">System notification</SelectItem>
              <SelectItem value="sound">Sound</SelectItem>
              <SelectItem value="system-and-sound">System notification and sound</SelectItem>
            </SelectPopup>
          </Select>
        </div>

        <div className="flex items-center justify-between border-b border-border py-2 last:border-b-0">
          <div>
            <p className="text-sm font-medium text-foreground">PR attention notifications</p>
            <p className="text-xs text-muted-foreground">
              Notify when PR Hub finds a pull request that needs your action.
            </p>
          </div>
          <Switch
            checked={settings.enablePrAttentionNotifications}
            onCheckedChange={(checked) =>
              updateSettings({
                enablePrAttentionNotifications: Boolean(checked),
              })
            }
            aria-label="PR attention notifications"
          />
        </div>

        <div className="rounded-lg border border-border bg-background px-3 py-3">
          <p className="text-xs font-medium text-foreground">Permission status</p>
          <p className="mt-1 text-xs text-muted-foreground capitalize">
            {notificationPermissionSummary}
          </p>
          {notificationPermission === "unsupported" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Notifications are unavailable in this environment.
            </p>
          ) : null}
          {notificationPermission === "denied" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Permission is currently denied in the browser. Re-enable it in your browser or desktop
              shell settings to resume notifications.
            </p>
          ) : null}
          {notificationPermission === "default" ? (
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="xs"
                onClick={requestNotificationPermission}
                disabled={!notificationsEnabled || isRequestingNotificationPermission}
              >
                {isRequestingNotificationPermission ? "Requesting..." : "Enable notifications"}
              </Button>
              {!notificationsEnabled ? (
                <span className="text-xs text-muted-foreground">
                  Turn a notification feature on before requesting permission.
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {NOTIFICATION_KEYS.some((key) => settings[key] !== defaults[key]) ? (
        <div className="mt-3 flex justify-end">
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateSettings(buildAppSettingsPatch(NOTIFICATION_KEYS, defaults))}
          >
            Restore default
          </Button>
        </div>
      ) : null}
    </section>
  );
}
