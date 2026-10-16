import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import { pendingLegacyThreadEnvMode } from "../lib/projectConfigReactQuery";
import {
  migrateLegacyClientSetting,
  PENDING_CLIENT_SETTINGS_STORAGE_KEY,
  readLegacyClientSetting,
} from "./useMigrateClientSettings";
const api = vi.hoisted(() => ({ migrateClientSetting: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ server: api }) }));
afterEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
});
it("does not migrate an absent browser key", async () => {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ tasksPanelAutoOpen: true }));
  expect(readLegacyClientSetting()).toBeUndefined();
  await migrateLegacyClientSetting();
  expect(api.migrateClientSetting).not.toHaveBeenCalled();
});
it("migrates explicit local once and removes only that key after acknowledgement", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "local", tasksPanelAutoOpen: true }),
  );
  let finish!: () => void;
  api.migrateClientSetting.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = migrateLegacyClientSetting();
  const second = migrateLegacyClientSetting();
  expect(api.migrateClientSetting).toHaveBeenCalledTimes(1);
  expect(readLegacyClientSetting()).toBe("local");
  finish();
  await Promise.all([first, second]);
  expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
    tasksPanelAutoOpen: true,
  });
});
it("retains the value after a failed request and retries without overwriting another client's winner", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "worktree" }),
  );
  api.migrateClientSetting.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(migrateLegacyClientSetting()).rejects.toThrow("Disconnected");
  expect(readLegacyClientSetting()).toBe("worktree");
  api.migrateClientSetting.mockResolvedValueOnce({ applied: false, currentValue: "local" });
  await migrateLegacyClientSetting();
  expect(readLegacyClientSetting()).toBeUndefined();
});

it("keeps an unacknowledged value when app settings are rewritten without it", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "worktree", tasksPanelAutoOpen: true }),
  );
  api.migrateClientSetting.mockRejectedValueOnce(new Error("Sync pending"));
  await expect(migrateLegacyClientSetting()).rejects.toThrow("Sync pending");
  // An app-settings write re-encodes the schema, which has no legacy keys.
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ tasksPanelAutoOpen: false }));
  expect(readLegacyClientSetting()).toBe("worktree");
  api.migrateClientSetting.mockResolvedValueOnce({ applied: true, currentValue: "worktree" });
  await migrateLegacyClientSetting();
  expect(api.migrateClientSetting).toHaveBeenLastCalledWith({
    key: "defaultThreadEnvMode",
    value: "worktree",
  });
  expect(readLegacyClientSetting()).toBeUndefined();
  expect(localStorage.getItem(PENDING_CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();
  expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
    tasksPanelAutoOpen: false,
  });
});

it("uses a pending workspace default only where the server would apply it", () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "worktree" }),
  );
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "global")).toBe("worktree");
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "default")).toBe("worktree");
  // Project-level values outrank the global default the migration fills.
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "project")).toBeUndefined();
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "f5.json")).toBeUndefined();
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "legacy-project")).toBeUndefined();
  // The server keeps the first migration for a key, so a later one loses.
  expect(
    pendingLegacyThreadEnvMode(
      {
        ...DEFAULT_SERVER_SETTINGS,
        clientSettingMigrations: { defaultThreadEnvMode: "2026-10-16T00:00:00.000Z" },
      },
      "global",
    ),
  ).toBeUndefined();
});

it("preserves an explicit disabled streaming preference during migration", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ enableAssistantStreaming: false }),
  );
  api.migrateClientSetting.mockResolvedValueOnce({ applied: true, currentValue: false });
  await migrateLegacyClientSetting();
  expect(api.migrateClientSetting).toHaveBeenCalledWith({
    key: "enableAssistantStreaming",
    value: false,
  });
  expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toEqual({});
});
