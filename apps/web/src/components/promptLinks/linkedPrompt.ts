import {
  DEFAULT_MODEL_BY_PROVIDER,
  isKnownProviderKind,
  ProviderInstanceId,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import type { LinkedPrompt } from "@t3tools/shared/promptLinks";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/shared/serverSettings";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cachedGlobalDraftSettings } from "~/lib/draftSettingsDefaults";

import { toastManager } from "../ui/toast";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: "This prompt had hidden characters, it may be malicious",
    description: `F5 removed ${prompt.hiddenCharacters} hidden character${prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.`,
    timeout: 0,
  });
}

/**
 * Puts a linked prompt in a thread's composer. It is never sent; when the thread already has a
 * different draft the user chooses whether to replace it.
 */
export function placeLinkedPrompt(
  threadId: ThreadId,
  prompt: LinkedPrompt,
  notes: ReadonlyArray<string> = [],
): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    useComposerDraftStore.getState().setPrompt(threadId, prompt.text);
    toastManager.add({
      type: "info",
      title: "Prompt added from a link",
      description: ["Read it before you send.", ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: "Linked prompt ready",
    description: "This thread already has a draft. Replace it with the linked prompt?",
    timeout: 0,
    actionProps: {
      children: "Replace draft",
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}

/**
 * Applies a link's provider and model to a new draft when that provider is set up and enabled
 * here. Returns a note for the user when the link's choice could not be honored.
 */
export function applyLinkedModel(
  threadId: ThreadId,
  link: { readonly provider: string | null; readonly model: string | null },
): string | null {
  if (link.provider === null) return null;
  const settings = cachedGlobalDraftSettings();
  const instanceId = ProviderInstanceId.make(link.provider);
  const instance = settings.providerInstances[instanceId];
  const driver = instance?.driver ?? link.provider;
  const configured =
    isKnownProviderKind(driver) &&
    (instance !== undefined || link.provider in settings.providers) &&
    resolveProjectProviderInstanceEnabled(settings, undefined, instanceId);
  if (!configured)
    return `The link asked for ${link.provider}, which is not set up here, so your default model is used.`;
  const provider = driver as ProviderKind;
  const draft = useComposerDraftStore.getState();
  draft.setProvider(threadId, provider);
  draft.setProviderInstance(threadId, instanceId);
  draft.setModel(threadId, link.model ?? DEFAULT_MODEL_BY_PROVIDER[provider]);
  return null;
}
