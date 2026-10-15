import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Equal } from "effect";
import { PlusIcon, RotateCwIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useSettingsRouteContext } from "../SettingsRouteContext";
import { useSettings as useUnifiedSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../../../lib/serverReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";

export { PROVIDERS_SETTINGS_DESCRIPTORS } from "./ProvidersSettings.descriptors";
import { AddProviderInstanceDialog } from "../AddProviderInstanceDialog";
import { ProviderInstanceCard } from "../ProviderInstanceCard";
import { getDriverOption } from "../providerDriverMeta";
import { SettingsCard, SettingsRow } from "../SettingsCard";
import {
  buildProviderInstanceUpdatePatch,
  mergeLegacyProviderOverrides,
  type LegacyProviderOverrides,
} from "../SettingsPanels.logic";

const BUILT_IN_PROVIDER_DRIVERS = [
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("cursor"),
  ProviderDriverKind.make("opencode"),
  ProviderDriverKind.make("grok"),
  ProviderDriverKind.make("muse"),
] as const;

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

interface ProviderInstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

export function ProvidersSettings() {
  const unifiedSettings = useUnifiedSettings();
  const { updateSettings: updateUnifiedSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const liveProviders = serverConfigQuery.data?.providers ?? [];
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(unifiedSettings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const providerInstanceRows: ProviderInstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(BUILT_IN_PROVIDER_DRIVERS);
  for (const driver of BUILT_IN_PROVIDER_DRIVERS) {
    type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
    const legacyProviders = unifiedSettings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = unifiedSettings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[driver]!;
    const defaultLegacyConfig = defaultLegacyProviders[driver]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    providerInstanceRows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty: explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig),
    });
    for (const [id, instance] of instancesByDriver.get(driver) ?? []) {
      if (id === defaultInstanceId) continue;
      providerInstanceRows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      providerInstanceRows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }

  const lastCheckedAt =
    liveProviders.length > 0
      ? liveProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          liveProviders[0]!.checkedAt,
        )
      : null;

  const updateProviderInstance = (
    row: ProviderInstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: ServerSettings["textGenerationModelSelection"];
    },
  ) => {
    updateUnifiedSettings(
      buildProviderInstanceUpdatePatch({
        settings: unifiedSettings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateUnifiedSettings({
      providerInstances: withoutProviderInstanceKey(unifiedSettings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(
        unifiedSettings.providerModelPreferences,
        id,
      ),
      dismissedProviderUpdateAdvisories: withoutProviderInstanceKey(
        unifiedSettings.dismissedProviderUpdateAdvisories,
        id,
      ),
      favorites: withoutProviderInstanceFavorites(unifiedSettings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(unifiedSettings.providerModelPreferences, instanceId);
    updateUnifiedSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateUnifiedSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(unifiedSettings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateUnifiedSettings({
      providers: {
        ...unifiedSettings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof unifiedSettings.providers,
      providerInstances: withoutProviderInstanceKey(
        unifiedSettings.providerInstances,
        defaultInstanceId,
      ),
      providerModelPreferences: withoutProviderInstanceKey(
        unifiedSettings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(
        unifiedSettings.favorites ?? [],
        defaultInstanceId,
      ),
    });
  };
  const refreshProviders = () => {
    if (isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .then(({ providers }) => {
        queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
          existing ? { ...existing, providers } : existing,
        );
      })
      .catch((error) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        setIsRefreshingProviders(false);
      });
  };

  return (
    <>
      <section
        className="rounded-2xl border border-border bg-card"
        data-settings-search-target="providers.instances"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-medium text-foreground">Provider instances</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure built-in and custom provider instances. Unavailable providers stay visible
              here and in the picker until their CLI/auth probe passes.
            </p>
            {lastCheckedAt ? (
              <p className="mt-1 text-2xs text-muted-foreground">
                Last checked: <code>{lastCheckedAt}</code>
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={refreshProviders}
              disabled={isRefreshingProviders || serverConfigQuery.isFetching}
            >
              <RotateCwIcon className={`size-3 ${isRefreshingProviders ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="xs" onClick={() => setIsAddInstanceDialogOpen(true)}>
              <PlusIcon className="size-3" />
              Add
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Check for provider updates</p>
            <p className="text-xs text-muted-foreground">
              Periodically check installed provider CLIs for newer versions.
            </p>
          </div>
          <Switch
            checked={unifiedSettings.enableProviderUpdateChecks}
            onCheckedChange={(checked) =>
              updateUnifiedSettings({ enableProviderUpdateChecks: Boolean(checked) })
            }
            aria-label="Check for provider updates"
          />
        </div>

        <div>
          {providerInstanceRows.map((row) => {
            const driverOption = getDriverOption(row.driver);
            const liveProvider: ServerProvider | undefined = liveProviders.find(
              (candidate) => candidate.instanceId === row.instanceId,
            );
            const modelPreferences = unifiedSettings.providerModelPreferences?.[row.instanceId] ?? {
              hiddenModels: [],
              modelOrder: [],
            };
            const favoriteModels = (unifiedSettings.favorites ?? [])
              .filter((favorite) => favorite.provider === row.instanceId)
              .map((favorite) => favorite.model);
            const resetLabel = driverOption?.label ?? String(row.driver);
            return (
              <ProviderInstanceCard
                key={row.instanceId}
                instanceId={row.instanceId}
                instance={row.instance}
                driverOption={driverOption}
                liveProvider={liveProvider}
                isExpanded={openInstanceDetails[row.instanceId] ?? false}
                onExpandedChange={(open) =>
                  setOpenInstanceDetails((existing) => ({
                    ...existing,
                    [row.instanceId]: open,
                  }))
                }
                onUpdate={(next) => {
                  const wasEnabled = row.instance.enabled ?? true;
                  const isDisabling = next.enabled === false && wasEnabled;
                  const shouldClearTextGen =
                    isDisabling &&
                    unifiedSettings.textGenerationModelSelection.instanceId === row.instanceId;
                  updateProviderInstance(
                    row,
                    next,
                    shouldClearTextGen
                      ? {
                          textGenerationModelSelection:
                            DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                        }
                      : undefined,
                  );
                }}
                onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
                dismissedProviderUpdateAdvisory={
                  unifiedSettings.dismissedProviderUpdateAdvisories[row.instanceId]
                }
                onDismissProviderUpdateAdvisory={(latestVersion) =>
                  updateUnifiedSettings({
                    dismissedProviderUpdateAdvisories: {
                      ...unifiedSettings.dismissedProviderUpdateAdvisories,
                      [row.instanceId]: latestVersion,
                    },
                  })
                }
                headerAction={
                  row.isDefault && row.isDirty ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => resetDefaultInstance(row.driver)}
                      aria-label={`Reset ${resetLabel} provider settings`}
                    >
                      <RotateCwIcon className="size-3" />
                    </Button>
                  ) : null
                }
                hiddenModels={modelPreferences.hiddenModels}
                favoriteModels={favoriteModels}
                modelOrder={modelPreferences.modelOrder}
                onHiddenModelsChange={(hiddenModels) =>
                  updateProviderModelPreferences(row.instanceId, {
                    ...modelPreferences,
                    hiddenModels,
                  })
                }
                onFavoriteModelsChange={(nextFavoriteModels) =>
                  updateProviderFavoriteModels(row.instanceId, nextFavoriteModels)
                }
                onModelOrderChange={(modelOrder) =>
                  updateProviderModelPreferences(row.instanceId, {
                    ...modelPreferences,
                    modelOrder,
                  })
                }
              />
            );
          })}
        </div>
      </section>

      <LegacyProviderOverridesCard rows={providerInstanceRows} onMove={updateProviderInstance} />

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />
    </>
  );
}

interface LegacyProviderEntry {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly overrides: LegacyProviderOverrides;
  /** Client settings that reset this provider's legacy overrides. */
  readonly clearPatch: Parameters<ReturnType<typeof useSettingsRouteContext>["updateSettings"]>[0];
}

function describeLegacyOverrides(overrides: LegacyProviderOverrides): string {
  return [
    overrides.binaryPath ? `binary ${overrides.binaryPath}` : null,
    overrides.homePath ? `home ${overrides.homePath}` : null,
    overrides.launchArgs ? `arguments ${overrides.launchArgs}` : null,
    overrides.customModels?.length
      ? `${overrides.customModels.length} custom model${overrides.customModels.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * App-wide Codex/Claude/Grok overrides from before per-instance configuration.
 * They still apply to new sessions, so they stay readable here until moved into
 * the default instance or cleared. Hidden when nothing is set.
 */
function LegacyProviderOverridesCard({
  rows,
  onMove,
}: {
  readonly rows: ReadonlyArray<ProviderInstanceRow>;
  readonly onMove: (row: ProviderInstanceRow, next: ProviderInstanceConfig) => void;
}) {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  const entries: LegacyProviderEntry[] = [
    {
      driver: ProviderDriverKind.make("codex"),
      label: "Codex",
      overrides: {
        binaryPath: settings.codexBinaryPath,
        homePath: settings.codexHomePath,
        customModels: settings.customCodexModels,
      },
      clearPatch: {
        codexBinaryPath: defaults.codexBinaryPath,
        codexHomePath: defaults.codexHomePath,
        customCodexModels: defaults.customCodexModels,
      },
    },
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      label: "Claude",
      overrides: {
        binaryPath: settings.claudeBinaryPath,
        launchArgs: settings.claudeLaunchArgs,
        customModels: settings.customClaudeModels,
      },
      clearPatch: {
        claudeBinaryPath: defaults.claudeBinaryPath,
        claudeLaunchArgs: defaults.claudeLaunchArgs,
        customClaudeModels: defaults.customClaudeModels,
      },
    },
    {
      driver: ProviderDriverKind.make("grok"),
      label: "Grok",
      overrides: { customModels: settings.customGrokModels },
      clearPatch: { customGrokModels: defaults.customGrokModels },
    },
  ].filter((entry) => describeLegacyOverrides(entry.overrides).length > 0);

  if (entries.length === 0) return null;

  return (
    <SettingsCard
      title="Legacy provider overrides"
      searchTarget="providers.legacy-overrides"
      description="These app-wide values predate per-instance settings and still apply to new sessions. Move them into the default instance so they are edited in one place, or clear them."
    >
      {entries.map((entry) => {
        const row = rows.find(
          (candidate) => candidate.isDefault && candidate.driver === entry.driver,
        );
        return (
          <SettingsRow
            key={entry.driver}
            title={entry.label}
            description={describeLegacyOverrides(entry.overrides)}
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!row}
                  onClick={() => {
                    if (!row) return;
                    const { instance, skipped } = mergeLegacyProviderOverrides(
                      row.instance,
                      entry.overrides,
                    );
                    onMove(row, instance);
                    updateSettings(entry.clearPatch);
                    toastManager.add(
                      skipped.length > 0
                        ? {
                            type: "warning",
                            title: `${entry.label} overrides moved`,
                            description: `The instance already set ${skipped.join(", ")}, so those kept the instance value.`,
                          }
                        : { type: "success", title: `${entry.label} overrides moved` },
                    );
                  }}
                >
                  Move to default instance
                </Button>
                <Button size="xs" variant="ghost" onClick={() => updateSettings(entry.clearPatch)}>
                  Clear
                </Button>
              </div>
            }
          />
        );
      })}
    </SettingsCard>
  );
}
