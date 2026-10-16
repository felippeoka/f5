import { cachedGlobalDraftSettings } from "./draftSettingsDefaults";
import { useStore } from "../store";
import type {
  ProjectId,
  ProjectSettingsResult,
  ServerSettings,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { nonDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";

import { projectSettingsQueryOptions } from "./projectSettingsQuery";
import {
  migrateLegacyClientSetting,
  readLegacyClientSetting,
} from "../hooks/useMigrateClientSettings";
import { ensureNativeApi } from "../nativeApi";

const CHECKED_IN_PROJECT_CONFIG_STALE_TIME_MS = 5_000;

export const projectCheckedInConfigQueryOptions = (projectId: ProjectId) =>
  queryOptions({
    queryKey: ["projects", projectId, "checked-in-config"] as const,
    queryFn: () => ensureNativeApi().projects.getCheckedInConfig({ projectId }),
    staleTime: CHECKED_IN_PROJECT_CONFIG_STALE_TIME_MS,
  });

export interface ResolveProjectThreadEnvModeOptions {
  readonly requested?: ThreadEnvMode;
  readonly forceNonDefault?: boolean;
}

export function resolveCachedProjectThreadEnvMode(projectId: ProjectId): ThreadEnvMode {
  const global = cachedGlobalDraftSettings();
  const project = useStore.getState().projects.find((p) => p.id === projectId);
  return (
    global.projectSettingsOverrides[projectId]?.defaultThreadEnvMode ??
    project?.defaultEnvMode ??
    global.defaultThreadEnvMode
  );
}

type ThreadEnvModeSource = ProjectSettingsResult["sources"]["defaultThreadEnvMode"];

function cachedProjectThreadEnvModeSource(projectId: ProjectId): ThreadEnvModeSource {
  const global = cachedGlobalDraftSettings();
  if (global.projectSettingsOverrides[projectId]?.defaultThreadEnvMode !== undefined)
    return "project";
  const project = useStore.getState().projects.find((p) => p.id === projectId);
  return project?.defaultEnvMode ? "legacy-project" : "global";
}

/**
 * The browser's legacy workspace default while its migration is still pending,
 * when the server will accept it: it applies only the first migration per key,
 * and project-level values outrank the global default it fills.
 */
export function pendingLegacyThreadEnvMode(
  settings: ServerSettings,
  source: ThreadEnvModeSource,
): ThreadEnvMode | undefined {
  if (settings.clientSettingMigrations.defaultThreadEnvMode) return undefined;
  if (source !== "global" && source !== "default") return undefined;
  return readLegacyClientSetting();
}

export function useProjectThreadEnvModeResolver() {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      projectId: ProjectId,
      options: ResolveProjectThreadEnvModeOptions = {},
    ): Promise<ThreadEnvMode> => {
      if (options.requested)
        return options.forceNonDefault
          ? nonDefaultThreadEnvMode(options.requested)
          : options.requested;
      const hadPendingMigration = readLegacyClientSetting() !== undefined;
      await migrateLegacyClientSetting().catch(() => undefined);
      const query = projectSettingsQueryOptions(projectId);
      const { settings, source } = await queryClient
        // A copy fetched before the migration landed would carry the old default.
        .fetchQuery(hadPendingMigration ? { ...query, staleTime: 0 } : query)
        .then((result) => ({
          settings: result.settings,
          source: result.sources.defaultThreadEnvMode,
        }))
        .catch(() => {
          const cached = queryClient.getQueryData(query.queryKey);
          if (cached)
            return { settings: cached.settings, source: cached.sources.defaultThreadEnvMode };
          const global = cachedGlobalDraftSettings();
          return {
            settings: {
              ...global,
              defaultThreadEnvMode: resolveCachedProjectThreadEnvMode(projectId),
            },
            source: cachedProjectThreadEnvModeSource(projectId),
          };
        });
      const envMode = pendingLegacyThreadEnvMode(settings, source) ?? settings.defaultThreadEnvMode;
      return options.forceNonDefault ? nonDefaultThreadEnvMode(envMode) : envMode;
    },
    [queryClient],
  );
}
