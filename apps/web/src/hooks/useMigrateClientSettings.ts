import type { MigrateClientSettingInput } from "@t3tools/contracts";
import { rememberDraftSettings } from "../lib/draftSettingsDefaults";
import { useQuery } from "@tanstack/react-query";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { PROJECT_SETTINGS_QUERY_KEY } from "../lib/projectSettingsQuery";

/**
 * Legacy values awaiting server acknowledgement. App-settings writes re-encode
 * the schema and drop unknown keys, so values wait here instead of there.
 */
export const PENDING_CLIENT_SETTINGS_STORAGE_KEY = "t3code:pending-client-settings:v1";
const LEGACY_KEYS = ["defaultThreadEnvMode", "enableAssistantStreaming"] as const;

function readStoredObject(key: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function toInputs(values: Record<string, unknown>): MigrateClientSettingInput[] {
  const inputs: MigrateClientSettingInput[] = [];
  const env = values.defaultThreadEnvMode;
  if (env === "local" || env === "worktree")
    inputs.push({ key: "defaultThreadEnvMode", value: env });
  if (typeof values.enableAssistantStreaming === "boolean")
    inputs.push({ key: "enableAssistantStreaming", value: values.enableAssistantStreaming });
  return inputs;
}

/** Pending legacy values, first moving any still in app settings to the pending key. */
function readLegacyClientSettings(): MigrateClientSettingInput[] {
  const pending = readStoredObject(PENDING_CLIENT_SETTINGS_STORAGE_KEY) ?? {};
  // Malformed app settings stay untouched.
  const app = readStoredObject(APP_SETTINGS_STORAGE_KEY);
  const fromApp = app ? toInputs(app) : [];
  const inputs = toInputs({
    ...Object.fromEntries(fromApp.map((input) => [input.key, input.value])),
    ...pending,
  });
  if (app && fromApp.length > 0) {
    try {
      localStorage.setItem(
        PENDING_CLIENT_SETTINGS_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(inputs.map((input) => [input.key, input.value]))),
      );
      for (const key of LEGACY_KEYS) delete app[key];
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(app));
    } catch {
      /* Storage is full or blocked; the values stay in app settings. */
    }
  }
  return inputs;
}

export function readLegacyClientSetting(): "local" | "worktree" | undefined {
  return readLegacyClientSettings().find((input) => input.key === "defaultThreadEnvMode")?.value as
    | "local"
    | "worktree"
    | undefined;
}

function forgetLegacyClientSetting(key: MigrateClientSettingInput["key"]): void {
  for (const storageKey of [PENDING_CLIENT_SETTINGS_STORAGE_KEY, APP_SETTINGS_STORAGE_KEY]) {
    const stored = readStoredObject(storageKey);
    if (!stored || !(key in stored)) continue;
    delete stored[key];
    if (storageKey === PENDING_CLIENT_SETTINGS_STORAGE_KEY && Object.keys(stored).length === 0)
      localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(stored));
  }
}

let migration: Promise<void> | undefined;
export function migrateLegacyClientSetting(inputs = readLegacyClientSettings()): Promise<void> {
  if (migration) return migration;
  if (inputs.length === 0) return Promise.resolve();
  migration = (async () => {
    for (const input of inputs) {
      await ensureNativeApi().server.migrateClientSetting(input);
      forgetLegacyClientSetting(input.key);
    }
  })().finally(() => {
    migration = undefined;
  });
  return migration;
}

export function useMigrateClientSettings() {
  // Reading during the first render moves legacy values out of app settings
  // before any effect can rewrite them.
  useRef(readLegacyClientSettings());
  const client = useQueryClient();
  const config = useQuery(serverConfigQueryOptions());
  useEffect(() => {
    if (config.data?.settings) rememberDraftSettings(config.data.settings);
  }, [config.data?.settings]);
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    const run = () => {
      void migrateLegacyClientSetting()
        .then(() => {
          if (cancelled) return;
          void client.invalidateQueries({ queryKey: serverQueryKeys.config() });
          // Project settings resolve the migrated keys as well.
          void client.invalidateQueries({ queryKey: PROJECT_SETTINGS_QUERY_KEY });
        })
        .catch(() => {
          if (!cancelled) retry = setTimeout(run, 5000);
        });
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [client]);
}
