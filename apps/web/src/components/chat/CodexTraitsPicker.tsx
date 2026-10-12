import {
  ProviderDriverKind,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  normalizeCodexModelOptions,
  resolveCodexReasoningEffortForModel,
  resolveModelCapabilities,
} from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { recordModelSelection } from "../../modelPreferencesStore";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { EffortMenuSection, FastModeLabel, FastModeTriggerIcon } from "./EffortMenuSection";
import { getEffortLevel } from "./effortLevels";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

/** Same resolver the server uses for `turn/start`, fed with reported capabilities. */
function resolveCodexTraitCapabilities(
  model: string,
  models: ReadonlyArray<ServerProviderModel> | undefined,
) {
  return resolveModelCapabilities(
    "codex",
    model,
    models ? getProviderModelCapabilities(models, model, CODEX_PROVIDER) : undefined,
  );
}

function getSelectedCodexTraits(
  model: string,
  modelOptions: CodexModelOptions | null | undefined,
  models?: ReadonlyArray<ServerProviderModel>,
): {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
} {
  const capabilities = resolveCodexTraitCapabilities(model, models);
  const requested = modelOptions?.reasoningEffort;
  const effort =
    capabilities.source === "reported"
      ? ((requested && capabilities.effortOptions.includes(requested)
          ? requested
          : capabilities.defaultEffort) as CodexReasoningEffort | undefined)
      : undefined;
  return {
    effort: effort ?? resolveCodexReasoningEffortForModel(model, requested),
    fastModeEnabled: modelOptions?.fastMode === true && capabilities.supportsFastMode,
  };
}

function CodexTraitsMenuContentImpl(props: {
  threadId: ThreadId;
  model: string;
  models?: ReadonlyArray<ServerProviderModel>;
  onSelectionComplete?: () => void;
}) {
  const draft = useComposerThreadDraft(props.threadId);
  const modelOptions = draft.modelOptions?.codex;
  const setModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const reported = props.models
    ? getProviderModelCapabilities(props.models, props.model, CODEX_PROVIDER)
    : undefined;
  const capabilities = resolveCodexTraitCapabilities(props.model, props.models);
  const options = capabilities.effortOptions as ReadonlyArray<CodexReasoningEffort>;
  const defaultReasoningEffort = capabilities.defaultEffort;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(
    props.model,
    modelOptions,
    props.models,
  );

  const setCodexModelOptions = (nextCodexModelOptions: CodexModelOptions | undefined) => {
    const { codex: _discardedCodex, ...otherProviderModelOptions } = draft.modelOptions ?? {};
    const nextProviderModelOptions: ProviderModelOptions | undefined = nextCodexModelOptions
      ? { ...otherProviderModelOptions, codex: nextCodexModelOptions }
      : Object.keys(otherProviderModelOptions).length > 0
        ? otherProviderModelOptions
        : undefined;
    setModelOptions(props.threadId, nextProviderModelOptions);
    // Record the (provider, model, options) triple so the MRU used by
    // `model.switchRecent` keeps the fresh options attached to the codex
    // model the user is actively editing.
    recordModelSelection("codex", props.model, nextProviderModelOptions);
  };

  return (
    <>
      <EffortMenuSection
        options={options.map((option) => ({
          id: option,
          label: CODEX_REASONING_LABELS[option],
          isDefault: option === defaultReasoningEffort,
        }))}
        value={effort}
        onValueChange={(value) => {
          const nextEffort = options.find((option) => option === value);
          if (!nextEffort) return;
          setCodexModelOptions(
            normalizeCodexModelOptions(
              props.model,
              { ...modelOptions, reasoningEffort: nextEffort },
              reported,
            ),
          );
          props.onSelectionComplete?.();
        }}
      />
      {capabilities.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuCheckboxItem
            variant="switch"
            checked={fastModeEnabled}
            onCheckedChange={(checked) => {
              setCodexModelOptions(
                normalizeCodexModelOptions(
                  props.model,
                  { ...modelOptions, fastMode: checked },
                  reported,
                ),
              );
            }}
          >
            <FastModeLabel enabled={fastModeEnabled} />
          </MenuCheckboxItem>
        </>
      ) : null}
    </>
  );
}

export const CodexTraitsMenuContent = memo(CodexTraitsMenuContentImpl);

export const CodexTraitsPicker = memo(function CodexTraitsPicker(props: {
  threadId: ThreadId;
  model: string;
  models?: ReadonlyArray<ServerProviderModel>;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const modelOptions = useComposerThreadDraft(props.threadId).modelOptions?.codex;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(
    props.model,
    modelOptions,
    props.models,
  );
  const triggerLabel = CODEX_REASONING_LABELS[effort];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        data-composer-control="effort"
        data-effort-level={effort}
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              "min-w-0 max-w-40 shrink justify-start overflow-hidden sm:max-w-48 [&_svg]:mx-0",
              getEffortLevel(effort)?.chipClass,
            )}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {triggerLabel}
          {fastModeEnabled ? <FastModeTriggerIcon /> : null}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <CodexTraitsMenuContent
          threadId={props.threadId}
          model={props.model}
          {...(props.models ? { models: props.models } : {})}
          onSelectionComplete={() => {
            setIsMenuOpen(false);
          }}
        />
      </MenuPopup>
    </Menu>
  );
});
