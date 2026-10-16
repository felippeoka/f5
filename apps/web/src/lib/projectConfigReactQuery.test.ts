import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import {
  cachedProjectThreadEnvModeSource,
  resolveCachedProjectThreadEnvMode,
} from "./projectConfigReactQuery";
import { rememberDraftSettings, defaultDraftRuntimeMode } from "./draftSettingsDefaults";
const id = ProjectId.makeUnsafe("cached-project");
describe("cached draft defaults", () => {
  it("keeps resolved project permissions across unrelated global updates", () => {
    rememberDraftSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
      id,
    );
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    expect(defaultDraftRuntimeMode(id)).toBe("approval-required");
    expect(defaultDraftRuntimeMode(ProjectId.makeUnsafe("never-loaded"))).toBe("approval-required");
  });
  it("uses a saved project workspace override when the server is unavailable", () => {
    rememberDraftSettings({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "worktree" } },
    });
    expect(resolveCachedProjectThreadEnvMode(id)).toBe("worktree");
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    expect(resolveCachedProjectThreadEnvMode(id)).toBe("local");
  });
  it("reports an unknown workspace source unless the checked-in config is cached", () => {
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    const checkedIn = {
      projectId: id,
      sourceFile: "f5.json" as const,
      defaultThreadEnvMode: null,
      iconPath: null,
      diagnostics: [],
    };
    expect(cachedProjectThreadEnvModeSource(id, undefined)).toBeNull();
    expect(cachedProjectThreadEnvModeSource(id, checkedIn)).toBe("global");
    expect(
      cachedProjectThreadEnvModeSource(id, { ...checkedIn, defaultThreadEnvMode: "local" }),
    ).toBe("f5.json");
    expect(
      cachedProjectThreadEnvModeSource(id, {
        ...checkedIn,
        sourceFile: "t3.json",
        settings: { defaultThreadEnvMode: "local" },
      }),
    ).toBe("t3.json");
    rememberDraftSettings({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "worktree" } },
    });
    expect(cachedProjectThreadEnvModeSource(id, undefined)).toBe("project");
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
  });
});
