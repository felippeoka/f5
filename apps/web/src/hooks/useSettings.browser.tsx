import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProjectSettingsResult,
  type ServerSettings,
} from "@t3tools/contracts";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import { projectSettingsQueryOptions } from "../lib/projectSettingsQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { LOCAL_STORAGE_CHANGE_EVENT } from "./useLocalStorage";
import { useSettings, type UnifiedWebSettings } from "./useSettings";

vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => {
    throw new Error("useSettings must read seeded query data in this test");
  },
}));

const PROJECT_ID = ProjectId.makeUnsafe("project-settings-browser");

function seedQueryClient(serverSettings: ServerSettings = DEFAULT_SERVER_SETTINGS) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverConfigQueryOptions().queryKey, {
    settings: serverSettings,
  } as never);
  return queryClient;
}

function writeAppSettings(patch: Record<string, unknown>) {
  const current = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "{}");
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
  window.dispatchEvent(
    new CustomEvent(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key: APP_SETTINGS_STORAGE_KEY },
    }),
  );
}

function SettingProbe<T>(props: {
  name: string;
  selector: (settings: UnifiedWebSettings) => T;
  projectId?: ProjectId;
}) {
  const value = useSettings(props.selector, props.projectId);
  const renders = useRef(0);
  renders.current += 1;
  return (
    <div data-probe={props.name} data-renders={renders.current}>
      {JSON.stringify(value)}
    </div>
  );
}

function probe(name: string) {
  const element = document.querySelector<HTMLElement>(`[data-probe="${name}"]`);
  if (!element) throw new Error(`Missing probe ${name}`);
  return { renders: Number(element.dataset.renders), text: element.textContent };
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("useSettings", () => {
  it("re-renders only the subscribers whose selected value changed", async () => {
    const queryClient = seedQueryClient();
    const objectSelections: unknown[] = [];
    function ObjectProbe() {
      const value = useSettings((settings) => ({ wrap: settings.diffWordWrap }));
      objectSelections.push(value);
      return null;
    }
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SettingProbe name="app" selector={(settings) => settings.diffWordWrap} />
        <SettingProbe
          name="server"
          selector={(settings) => settings.resumeActiveTurnsAfterRestart}
        />
        <ObjectProbe />
      </QueryClientProvider>,
    );
    try {
      const initial = { app: probe("app"), server: probe("server") };

      writeAppSettings({ sidebarThreadPreviewCount: 10 });
      queryClient.setQueryData(serverConfigQueryOptions().queryKey, {
        settings: { ...DEFAULT_SERVER_SETTINGS, worktreeSubmodules: "recursive" },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(probe("app")).toEqual(initial.app);
      expect(probe("server")).toEqual(initial.server);
      expect(new Set(objectSelections).size).toBe(1);

      writeAppSettings({ diffWordWrap: !JSON.parse(initial.app.text ?? "false") });
      await vi.waitFor(() => {
        expect(probe("app").renders).toBe(initial.app.renders + 1);
      });
      expect(probe("server")).toEqual(initial.server);
      expect(new Set(objectSelections).size).toBe(2);

      queryClient.setQueryData(serverConfigQueryOptions().queryKey, {
        settings: { ...DEFAULT_SERVER_SETTINGS, resumeActiveTurnsAfterRestart: true },
      } as never);
      await vi.waitFor(() => {
        expect(probe("server").text).toBe("true");
      });
      expect(probe("server").renders).toBe(initial.server.renders + 1);
    } finally {
      await screen.unmount();
    }
  });

  it("applies project-scoped overrides and follows their updates", async () => {
    const queryClient = seedQueryClient();
    const projectResult = (resumeActiveTurnsAfterRestart: boolean) =>
      ({
        settings: { ...DEFAULT_SERVER_SETTINGS, resumeActiveTurnsAfterRestart },
        sources: {},
        overrides: {},
      }) as unknown as ProjectSettingsResult;
    queryClient.setQueryData(projectSettingsQueryOptions(PROJECT_ID).queryKey, projectResult(true));
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SettingProbe
          name="global"
          selector={(settings) => settings.resumeActiveTurnsAfterRestart}
        />
        <SettingProbe
          name="project"
          projectId={PROJECT_ID}
          selector={(settings) => settings.resumeActiveTurnsAfterRestart}
        />
      </QueryClientProvider>,
    );
    try {
      expect(probe("global").text).toBe("false");
      expect(probe("project").text).toBe("true");
      const globalRenders = probe("global").renders;

      queryClient.setQueryData(
        projectSettingsQueryOptions(PROJECT_ID).queryKey,
        projectResult(false),
      );
      await vi.waitFor(() => {
        expect(probe("project").text).toBe("false");
      });
      expect(probe("global").renders).toBe(globalRenders);
    } finally {
      await screen.unmount();
    }
  });
});
