import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type ModelSlug,
  ProviderInstanceId,
  ProviderDriverKind,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskConfiguration,
  type ProjectId,
  isKnownProviderKind,
} from "@t3tools/contracts";
import { createModelSelection, getDefaultModel } from "@t3tools/shared/model";
import { buildSlashComposerMenuItems } from "@t3tools/shared/slashCommands";
import type { Project } from "../../types";
import { useStore } from "../../store";
import { useSettings, type UnifiedWebSettings } from "../../hooks/useSettings";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { resolveNewThreadPreferences } from "../../newThreadPreferences";
import { getModelPreferences } from "../../modelPreferencesStore";
import {
  resolveAppModelSelectionForInstance,
  getCustomModelOptionsByInstance,
} from "../../modelSelection";
import { providerModelOptionsToSelections } from "../../providerModelOptions";
import { ensureNativeApi } from "../../nativeApi";
import { useTheme } from "../../hooks/useTheme";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import { ComposerCommandMenu, type ComposerCommandItem } from "../chat/ComposerCommandMenu";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { getComposerProviderState } from "../chat/composerProviderState";
import { RuntimeModePicker } from "../chat/RuntimeModePicker";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  isMetadataOnlyScheduleEdit,
  confirmedSchedule,
  validateScheduledDraft,
  type PreviewState,
} from "./schedulePreview";

export function ScheduledTaskDialog(props: {
  projectId: ProjectId;
  task?: ScheduledTask;
  onClose: () => void;
  onSaved: () => void;
  onProjectChange?: (id: ProjectId) => void;
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === props.projectId));
  const config = useQuery(serverConfigQueryOptions());
  const settings = useSettings(undefined, props.projectId);
  const projectSettings = useQuery(projectSettingsQueryOptions(props.projectId));
  const branches = useQuery(
    gitBranchesQueryOptions({ cwd: project?.cwd ?? null, autoRefresh: false }),
  );
  if (!project || !config.data || branches.isPending || projectSettings.isPending)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Scheduled task</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p role="status">Loading execution settings…</p>
            <Button onClick={props.onClose}>Cancel</Button>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    );
  return (
    <Editor
      {...props}
      project={project}
      settings={settings}
      providers={config.data.providers}
      branches={branches.data}
    />
  );
}
function Editor(
  props: Parameters<typeof ScheduledTaskDialog>[0] & {
    project: Project;
    settings: UnifiedWebSettings;
    providers: ReadonlyArray<import("@t3tools/contracts").ServerProvider>;
    branches: import("@t3tools/contracts").GitListBranchesResult | undefined;
  },
) {
  const preferences = resolveNewThreadPreferences(
    props.project,
    props.settings,
    getModelPreferences(),
  );
  const preferredProvider = props.providers.find(
    (p) => p.instanceId === (preferences.instanceId ?? preferences.provider),
  );
  const initialProvider =
    preferredProvider?.enabled &&
    preferredProvider.installed &&
    preferredProvider.status !== "error" &&
    preferredProvider.status !== "disabled"
      ? preferredProvider
      : props.providers.find(
          (p) => p.enabled && p.installed && p.status !== "error" && p.status !== "disabled",
        );
  const initialDriver =
    initialProvider && isKnownProviderKind(initialProvider.driver)
      ? initialProvider.driver
      : "codex";
  const keptPreference = initialProvider === preferredProvider;
  const initialModel =
    (initialProvider
      ? resolveAppModelSelectionForInstance(
          initialProvider.instanceId,
          props.settings,
          props.providers,
          keptPreference ? preferences.model : null,
        )
      : null) ?? getDefaultModel(initialDriver);
  const [value, setValue] = useState<ScheduledTaskConfiguration>(
    () =>
      props.task ?? {
        name: "",
        prompt: "",
        modelSelection: createModelSelection(
          initialProvider?.instanceId ?? ProviderInstanceId.make("codex"),
          initialModel,
          getComposerProviderState({
            provider: ProviderDriverKind.make(initialDriver),
            model: initialModel,
            models: initialProvider?.models ?? [],
            modelOptions: providerModelOptionsToSelections(
              initialDriver,
              keptPreference ? preferences.options : undefined,
            ),
          }).modelOptionsForDispatch,
        ),
        runtimeMode: props.settings.defaultRuntimeMode,
        workspace: {
          kind: "worktree",
          baseBranch:
            props.branches?.branches.find((b) => b.current)?.name ??
            props.branches?.branches.find((b) => b.isDefault)?.name ??
            "",
        },
        cron: "0 9 * * 1-5",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scheduleSource: "",
        maxRuns: null,
        oneShotAt: null,
        notify: "all",
        enabled: true,
      },
  );
  const [mode, setMode] = useState<"natural_language" | "preset" | "cron">(
    props.task ? "cron" : "natural_language",
  );
  const [schedule, setSchedule] = useState(props.task?.cron ?? "every weekday at 9am");
  const [preview, setPreview] = useState<PreviewState>({ kind: "unpreviewed" });
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(value.prompt.length);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const taskId = useRef(props.task?.id ?? ScheduledTaskId.makeUnsafe(crypto.randomUUID()));
  const requestedAt = useRef(new Date().toISOString());
  const key = JSON.stringify([props.projectId, value.timezone, mode, schedule]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => setPreview({ kind: "unpreviewed" }), [key]);
  const provider = props.providers.find((p) => p.instanceId === value.modelSelection.instanceId);
  const driver = provider?.driver ?? ProviderDriverKind.make("codex");
  const options = getCustomModelOptionsByInstance(props.settings, props.providers);
  const update = (patch: Partial<ScheduledTaskConfiguration>) =>
    setValue((v) => ({ ...v, ...patch }));
  const invocation = /^\s*\/([^\s]*)$/.exec(value.prompt.slice(0, cursor));
  const items = invocation
    ? buildSlashComposerMenuItems({
        query: invocation[1] ?? "",
        provider: isKnownProviderKind(driver) ? driver : undefined,
        projectSkills: props.project.skills,
        providerSkills: provider?.skills,
        runtimeSlashCommands: provider?.slashCommands?.map((c) => ({
          name: c.name,
          description: c.description ?? c.name,
        })),
        runtimeSlashCommandsSource: "instance",
      }).filter((i) => i.type === "skill")
    : [];
  const chooseSkill = (item: ComposerCommandItem) => {
    if (item.type !== "skill") return;
    const next = `/${item.name} ${value.prompt.slice(cursor)}`;
    update({ prompt: next });
    setCursor(item.name.length + 2);
  };
  const previewSchedule = async () => {
    setPreview({ kind: "loading", key });
    setError(null);
    try {
      const candidate = await ensureNativeApi().scheduledTasks.previewSchedule({
        projectId: props.projectId,
        timezone: value.timezone,
        schedule:
          mode === "natural_language"
            ? { kind: mode, text: schedule }
            : mode === "cron"
              ? { kind: mode, cron: schedule }
              : { kind: mode, preset: schedule as "hourly" | "daily" | "weekdays" | "weekly" },
      });
      if (currentKey.current === key) setPreview({ kind: "ready", key, preview: candidate });
    } catch (e) {
      if (currentKey.current === key)
        setPreview({
          kind: "error",
          key,
          message: e instanceof Error ? e.message : "Preview failed. Use a preset or cron.",
        });
    }
  };
  const metadataOnly =
    isMetadataOnlyScheduleEdit(props.task, value) &&
    mode === "cron" &&
    schedule === props.task?.cron;
  const metadataPreview =
    metadataOnly &&
    (preview.kind === "ready" || preview.kind === "confirmed") &&
    preview.key === key
      ? preview.preview
      : null;
  const candidate = confirmedSchedule(preview, key, mode === "natural_language") ?? metadataPreview;
  const save = async () => {
    if (!confirmedSchedule(preview, key, mode === "natural_language") && !metadataPreview) {
      setError("This preview expired or changed. Preview the schedule again.");
      setPreview({ kind: "unpreviewed" });
      return;
    }
    if (!candidate) return;
    const configuration = {
      ...value,
      cron: candidate.cron,
      timezone: candidate.timezone,
      scheduleSource: metadataOnly ? props.task!.scheduleSource : schedule,
      oneShotAt: metadataOnly ? props.task!.oneShotAt : candidate.oneShotAt,
      maxRuns: metadataOnly ? props.task!.maxRuns : candidate.oneShotAt ? 1 : value.maxRuns,
    };
    const problem = validateScheduledDraft(configuration);
    if (problem) {
      setError(problem);
      return;
    }
    setPreview({ kind: "saving", key, preview: candidate });
    try {
      const api = ensureNativeApi().scheduledTasks;
      const result = props.task
        ? await api.update({
            id: props.task.id,
            expectedVersion: props.task.version,
            configuration,
          })
        : await api.create({
            id: taskId.current,
            projectId: props.projectId,
            requestedAt: requestedAt.current,
            configuration,
          });
      for (const warning of result.warnings) toastManager.add({ type: "warning", title: warning });
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      setPreview({
        kind: mode === "natural_language" ? "confirmed" : "ready",
        key,
        preview: candidate,
      });
    }
  };
  const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.task ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription>
            Runs on this F5 server while it is running. Project: {props.project.name}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={preview.kind === "saving"} className="space-y-4">
            {props.onProjectChange && (
              <label>
                Project
                <select
                  value={props.projectId}
                  onChange={(e) => props.onProjectChange?.(e.target.value as ProjectId)}
                >
                  {useStore.getState().projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block">
              Name
              <Input
                aria-label="Task name"
                value={value.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <div>
              <p>Prompt</p>
              <ComposerPromptEditor
                value={value.prompt}
                cursor={cursor}
                terminalContexts={[]}
                disabled={preview.kind === "saving"}
                placeholder="Describe the work, or /skill-name args"
                className="min-h-24 rounded-md border p-3"
                onRemoveTerminalContext={() => {}}
                onPaste={() => {}}
                onChange={(prompt, cursor) => {
                  update({ prompt });
                  setCursor(cursor);
                }}
                onCommandKeyDown={(key) => {
                  const index = items.findIndex((i) => i.id === highlighted);
                  if (key === "ArrowDown" || key === "ArrowUp") {
                    if (!items.length) return false;
                    setHighlighted(
                      items[(index + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length]!
                        .id,
                    );
                    return true;
                  }
                  if ((key === "Enter" || key === "Tab") && items.length) {
                    chooseSkill(items[index >= 0 ? index : 0]!);
                    return true;
                  }
                  return false;
                }}
              />
              {items.length > 0 && (
                <ComposerCommandMenu
                  items={items}
                  resolvedTheme={resolvedTheme}
                  isLoading={false}
                  triggerKind="slash-command"
                  activeItemId={highlighted}
                  onHighlightedItemChange={setHighlighted}
                  onSelect={chooseSkill}
                />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <ProviderInstanceModelPicker
                instanceId={value.modelSelection.instanceId}
                model={value.modelSelection.model as ModelSlug}
                lockedInstanceId={null}
                providers={props.providers}
                modelOptionsByInstance={options}
                onInstanceModelChange={(instanceId, driver, model) =>
                  update({
                    modelSelection: createModelSelection(
                      instanceId,
                      model,
                      getComposerProviderState({
                        provider: driver,
                        model,
                        models:
                          props.providers.find((p) => p.instanceId === instanceId)?.models ?? [],
                        modelOptions: undefined,
                      }).modelOptionsForDispatch,
                    ),
                  })
                }
              />
              <TraitsPicker
                provider={driver}
                model={value.modelSelection.model}
                models={provider?.models ?? []}
                modelOptions={value.modelSelection.options}
                onModelOptionsChange={(options) =>
                  update({
                    modelSelection: createModelSelection(
                      value.modelSelection.instanceId,
                      value.modelSelection.model,
                      options,
                    ),
                  })
                }
              />
              {isKnownProviderKind(driver) && (
                <RuntimeModePicker
                  provider={driver}
                  value={value.runtimeMode}
                  onValueChange={(runtimeMode) => update({ runtimeMode })}
                />
              )}
            </div>
            <label className="block">
              Workspace
              <select
                aria-label="Workspace"
                className={fieldClass}
                value={value.workspace.kind}
                onChange={(e) =>
                  update({
                    workspace:
                      e.target.value === "worktree"
                        ? { kind: "worktree", baseBranch: "" }
                        : { kind: "projectRoot" },
                  })
                }
              >
                <option value="worktree">New worktree for every run</option>
                <option value="projectRoot">Project root (shared filesystem)</option>
              </select>
            </label>
            {value.workspace.kind === "worktree" && (
              <label className="block">
                Base branch
                <Input
                  list="schedule-branches"
                  aria-label="Base branch"
                  value={value.workspace.baseBranch}
                  onChange={(e) =>
                    update({ workspace: { kind: "worktree", baseBranch: e.target.value } })
                  }
                />
                <datalist id="schedule-branches">
                  {props.branches?.branches.map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">
                  A Git project and a base branch are required. Preparation never falls back to the
                  root.
                </p>
              </label>
            )}
            <label className="block">
              Timezone
              <Input
                aria-label="Timezone"
                value={value.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
              />
            </label>
            <label className="block">
              Schedule format
              <select
                className={fieldClass}
                value={mode}
                onChange={(e) => {
                  const mode = e.target.value as "natural_language" | "preset" | "cron";
                  setMode(mode);
                  setSchedule(
                    mode === "preset"
                      ? "daily"
                      : mode === "cron"
                        ? value.cron
                        : "every weekday at 9am",
                  );
                }}
              >
                <option value="natural_language">Natural language</option>
                <option value="preset">Preset</option>
                <option value="cron">Cron (advanced)</option>
              </select>
            </label>
            {mode === "preset" ? (
              <select
                aria-label="Preset"
                className={fieldClass}
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              >
                {["hourly", "daily", "weekdays", "weekly"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            ) : (
              <Input
                aria-label="Schedule"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              />
            )}
            <Button
              variant="outline"
              onClick={() => void previewSchedule()}
              disabled={preview.kind === "loading" || preview.kind === "saving"}
            >
              {preview.kind === "loading" ? "Converting…" : "Preview schedule"}
            </Button>
            {preview.kind === "error" && preview.key === key && (
              <p role="alert">{preview.message} Presets and raw cron remain available.</p>
            )}
            {(preview.kind === "ready" ||
              preview.kind === "confirmed" ||
              preview.kind === "saving") &&
              preview.key === key && (
                <div className="rounded-md border p-3" aria-live="polite">
                  <p>{preview.preview.summary}</p>
                  <code>{preview.preview.cron}</code>
                  <p>{preview.preview.timezone}</p>
                  <ol>
                    {preview.preview.nextFireTimes.map((time) => (
                      <li key={time}>
                        {new Date(time).toLocaleString(undefined, {
                          timeZone: preview.preview.timezone,
                          timeZoneName: "short",
                        })}
                      </li>
                    ))}
                  </ol>
                  {mode === "natural_language" && preview.kind === "ready" && (
                    <Button onClick={() => setPreview({ ...preview, kind: "confirmed" })}>
                      Use this schedule
                    </Button>
                  )}
                  {preview.preview.oneShotAt && <p>Runs once, then disables itself.</p>}
                </div>
              )}
            <label className="block">
              Notify
              <select
                aria-label="Notification policy"
                className={fieldClass}
                value={value.notify}
                onChange={(e) => update({ notify: e.target.value as typeof value.notify })}
              >
                <option value="all">Every outcome</option>
                <option value="failures_and_attention">Failures and attention</option>
                <option value="none">None</option>
              </select>
            </label>
            {error && <p role="alert">{error}</p>}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!candidate || preview.kind === "saving"} onClick={() => void save()}>
            {preview.kind === "saving" ? "Saving…" : "Save task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
