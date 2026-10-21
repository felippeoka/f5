import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS, ProjectId, type ScheduledTask } from "@t3tools/contracts";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";
import { createTestServerProvider } from "../../testServerProvider";
import { useStore } from "../../store";
import { TooltipProvider } from "../ui/tooltip";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
const mocks = vi.hoisted(() => ({ preview: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    scheduledTasks: { previewSchedule: mocks.preview, create: mocks.create, update: mocks.update },
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  vi.clearAllMocks();
});
const preview = {
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  summary: "Every weekday at 9 (UTC)",
  nextFireTimes: ["2099-01-01T09:00:00Z"],
  oneShotAt: null,
};
async function setup(task?: ScheduledTask) {
  const id = ProjectId.makeUnsafe("project");
  useStore.setState({
    projects: [
      {
        id,
        name: "Project",
        cwd: "/repo",
        model: "gpt-5.6-sol",
        defaultModel: "gpt-5.6-sol",
        createdAt: "2026-01-01T00:00:00Z",
        expanded: true,
        scripts: [],
        memories: [],
        skills: [],
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, {
    providers: [createTestServerProvider("codex")],
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  client.setQueryData<unknown>(
    gitBranchesQueryOptions({ cwd: "/repo", autoRefresh: false }).queryKey,
    {
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
      isRepo: true,
      hasOriginRemote: false,
    },
  );
  client.setQueryData<unknown>(projectSettingsQueryOptions(id).queryKey, {
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ScheduledTaskDialog
          projectId={id}
          {...(task ? { task } : {})}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
it("requires explicit natural-language confirmation and invalidates it on edits", async () => {
  mocks.preview.mockResolvedValue(preview);
  await setup();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview schedule" }).click();
  await expect.element(page.getByText(preview.summary)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await page.getByRole("button", { name: "Use this schedule" }).click();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Tokyo");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
});
it("keeps preset and cron editors usable after model failure and validates the prompt", async () => {
  mocks.preview.mockRejectedValueOnce(new Error("Model unavailable")).mockResolvedValue(preview);
  await setup();
  await page.getByRole("button", { name: "Preview schedule" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Presets and raw cron remain available");
  await page.getByRole("combobox", { name: "Schedule format" }).selectOptions("preset");
  await page.getByRole("button", { name: "Preview schedule" }).click();
  await page.getByRole("button", { name: "Save task" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a name and prompt");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("ignores a conversion response after its input changes", async () => {
  let resolve!: (value: typeof preview) => void;
  const promise = new Promise<typeof preview>((r) => {
    resolve = r;
  });
  mocks.preview.mockReturnValueOnce(promise).mockResolvedValue(preview);
  await setup();
  await page.getByRole("button", { name: "Preview schedule" }).click();
  await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Tokyo");
  resolve(preview);
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Preview schedule" })).toBeEnabled();
});

it("saves metadata on an expired one-shot without changing or reconverting its target", async () => {
  const task = {
    id: "expired",
    projectId: "project",
    name: "Expired",
    prompt: "Check",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    workspace: { kind: "projectRoot" },
    cron: "0 0 15 1 1 * 2020",
    timezone: "UTC",
    scheduleSource: "once",
    maxRuns: 1,
    oneShotAt: "2020-01-01T15:00:00.000Z",
    notify: "all",
    enabled: false,
    version: 1,
    createdBy: "user",
    authority: { kind: "user" },
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    runsConsumed: 1,
  } as ScheduledTask;
  mocks.preview.mockResolvedValue({
    ...preview,
    cron: task.cron,
    nextFireTimes: [],
    oneShotAt: null,
  });
  mocks.update.mockResolvedValue({ task, warnings: [] });
  await setup(task);
  await page.getByRole("textbox", { name: "Task name" }).fill("Renamed");
  await page.getByRole("button", { name: "Preview schedule" }).click();
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({
        name: "Renamed",
        oneShotAt: task.oneShotAt,
        maxRuns: 1,
        enabled: false,
      }),
    }),
  );
});
