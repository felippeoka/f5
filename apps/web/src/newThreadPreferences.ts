import { inferProviderForModel } from "@t3tools/shared/model";
import {
  isKnownProviderKind,
  type ServerSettings,
  type ProviderKind,
  type ProviderInstanceId,
  type ProviderModelOptions,
} from "@t3tools/contracts";
import { providerSelectionsToModelOptions } from "./providerModelOptions";
import type { Project } from "./types";
import type { ModelPreferencesState } from "./modelPreferencesStore";
/** Shared project/remembered defaults for new conversations and scheduled conversations. */
export function resolveNewThreadPreferences(
  project: Project | undefined,
  settings: ServerSettings,
  preferences: ModelPreferencesState,
): {
  provider?: ProviderKind;
  instanceId?: ProviderInstanceId;
  model?: string;
  options?: ProviderModelOptions | null;
} {
  if (project?.defaultModelSelection) {
    const selection = project.defaultModelSelection;
    const driver = settings.providerInstances[selection.instanceId]?.driver ?? selection.instanceId;
    const provider = isKnownProviderKind(driver)
      ? driver
      : inferProviderForModel(selection.model, "codex");
    return {
      provider,
      instanceId: selection.instanceId,
      model: selection.model,
      options: providerSelectionsToModelOptions(provider, selection.options),
    };
  }
  if (project?.defaultModel)
    return {
      provider: inferProviderForModel(project.defaultModel, "codex"),
      model: project.defaultModel,
    };
  return {
    ...(preferences.lastProvider ? { provider: preferences.lastProvider } : {}),
    ...(preferences.lastProvider && preferences.lastModelByProvider[preferences.lastProvider]
      ? { model: preferences.lastModelByProvider[preferences.lastProvider]! }
      : {}),
    ...(preferences.lastModelOptions ? { options: preferences.lastModelOptions } : {}),
  };
}
