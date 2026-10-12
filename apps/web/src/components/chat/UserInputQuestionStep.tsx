import type { UserInputQuestion } from "@t3tools/contracts";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Where custom text answers are typed: an inline "Other…" field inside the
 * step (message questions), or the composer below (blocking questions).
 */
export type UserInputCustomMode = "inline" | "composer";

/**
 * Where 1-9 option shortcuts listen. Blocking questions own the composer so
 * they listen on the document; message questions can stack, so each listens
 * only while focus is inside its own panel.
 */
export type UserInputShortcutScope = "document" | "panel";

interface UserInputQuestionStepProps {
  question: UserInputQuestion;
  questionIndex: number;
  questionCount: number;
  selectedOptionLabels: readonly string[];
  disabled: boolean;
  customMode: UserInputCustomMode;
  /** Inline mode: the typed answer and whether the "Other…" field is open. */
  customAnswer?: string;
  customOpen?: boolean;
  onCustomOpenChange?: (open: boolean) => void;
  onCustomAnswerChange?: (value: string) => void;
  /** Inline mode: Enter inside the "Other…" field. */
  onCustomSubmit?: () => void;
  onSelectOption: (optionLabel: string) => void;
  onToggleOption: (optionLabel: string) => void;
  /** Called after a single-select pick to move past this question. */
  onAdvance: () => void;
  /** Omitted hides the back control; on later steps it is always shown. */
  onBack?: (() => void) | undefined;
  /** Omitted disables the forward control. */
  onForward?: (() => void) | undefined;
  /** Keep a single-select pick on the last question from auto-advancing. */
  suppressAutoSubmit?: boolean;
  shortcutScope: UserInputShortcutScope;
  /** Document scope: let digits through once the composer holds custom text. */
  hasComposerCustomAnswer?: boolean;
  footer?: ReactNode;
}

const AUTO_ADVANCE_DELAY_MS = 200;

export function UserInputQuestionStep({
  question,
  questionIndex,
  questionCount,
  selectedOptionLabels,
  disabled,
  customMode,
  customAnswer = "",
  customOpen = false,
  onCustomOpenChange,
  onCustomAnswerChange,
  onCustomSubmit,
  onSelectOption,
  onToggleOption,
  onAdvance,
  onBack,
  onForward,
  suppressAutoSubmit = false,
  shortcutScope,
  hasComposerCustomAnswer = false,
  footer,
}: UserInputQuestionStepProps) {
  const [collapsed, setCollapsed] = useState(false);
  const isMultiSelect = question.multiSelect === true;
  const isLastQuestion = questionIndex >= questionCount - 1;
  const hasOptions = question.options.length > 0;
  const showInlineCustom = customMode === "inline";
  // A question without options can only be answered in free text.
  const customFieldOpen = showInlineCustom && (customOpen || !hasOptions);
  const customFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  // Track which question the pending auto-advance was armed for so a fast
  // question switch inside the 200ms window doesn't fire `onAdvance()` with
  // an unrelated active question.
  const autoAdvanceQuestionIdRef = useRef<string | null>(null);

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = null;
    autoAdvanceQuestionIdRef.current = null;
  }, []);

  useEffect(() => clearAutoAdvance, [clearAutoAdvance]);

  // Cancel any pending auto-advance whenever the active question changes,
  // so selecting option 1 on question A and immediately navigating to
  // question B doesn't fire the advance callback against B's context.
  useEffect(() => {
    if (autoAdvanceQuestionIdRef.current !== question.id) clearAutoAdvance();
  }, [clearAutoAdvance, question.id]);

  const selectOptionAndAutoAdvance = useCallback(
    (optionLabel: string) => {
      onSelectOption(optionLabel);
      clearAutoAdvance();
      if (suppressAutoSubmit && isLastQuestion) return;
      const questionId = question.id;
      autoAdvanceQuestionIdRef.current = questionId;
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        // Guard against firing after the active question changed in the
        // 200ms window (e.g. user clicked back to a previous question).
        if (autoAdvanceQuestionIdRef.current !== questionId) {
          autoAdvanceQuestionIdRef.current = null;
          return;
        }
        autoAdvanceQuestionIdRef.current = null;
        onAdvance();
      }, AUTO_ADVANCE_DELAY_MS);
    },
    [clearAutoAdvance, isLastQuestion, onAdvance, onSelectOption, question.id, suppressAutoSubmit],
  );

  const pickOption = useCallback(
    (optionLabel: string) => {
      if (isMultiSelect) onToggleOption(optionLabel);
      else selectOptionAndAutoAdvance(optionLabel);
    },
    [isMultiSelect, onToggleOption, selectOptionAndAutoAdvance],
  );

  const toggleCustom = useCallback(() => {
    clearAutoAdvance();
    // Single-select reopening keeps the field open; it is a choice, not a toggle.
    onCustomOpenChange?.(isMultiSelect ? !customOpen : true);
  }, [clearAutoAdvance, customOpen, isMultiSelect, onCustomOpenChange]);

  const hasOtherRow = showInlineCustom && hasOptions;
  const shortcutCount = question.options.length + (hasOtherRow ? 1 : 0);

  /** Returns true when the digit matched an option or the "Other…" row. */
  const applyDigitShortcut = (key: string): boolean => {
    const digit = Number.parseInt(key, 10);
    if (Number.isNaN(digit) || digit < 1 || digit > 9 || digit > shortcutCount) return false;
    const option = question.options[digit - 1];
    if (option) pickOption(option.label);
    else toggleCustom();
    return true;
  };
  const applyDigitShortcutRef = useRef(applyDigitShortcut);
  applyDigitShortcutRef.current = applyDigitShortcut;

  useEffect(() => {
    if (shortcutScope !== "document" || disabled || collapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      // If the user has started typing a custom answer in the contenteditable
      // composer, let digit keys pass through so they can type numbers.
      if (target instanceof HTMLElement && target.isContentEditable && hasComposerCustomAnswer) {
        return;
      }
      if (applyDigitShortcutRef.current(event.key)) event.preventDefault();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [collapsed, disabled, hasComposerCustomAnswer, shortcutScope]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (shortcutScope !== "panel" || disabled || collapsed) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    if (applyDigitShortcut(event.key)) event.preventDefault();
  };

  // Focus the field when the user opens "Other…", not when a step mounts.
  const previousCustomOpenRef = useRef(customOpen);
  useEffect(() => {
    if (customOpen && !previousCustomOpenRef.current) customFieldRef.current?.focus();
    previousCustomOpenRef.current = customOpen;
  }, [customOpen]);

  const selectedSet = new Set(selectedOptionLabels);
  const showNavigation = questionCount > 1;

  return (
    <div onKeyDown={onPanelKeyDown}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!collapsed}
          onClick={() => {
            clearAutoAdvance();
            setCollapsed((value) => !value);
          }}
        >
          {showNavigation ? (
            <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-2xs font-medium tabular-nums text-muted-foreground">
              {questionIndex + 1}/{questionCount}
            </span>
          ) : null}
          <span className="truncate text-2xs font-semibold tracking-widest text-muted-foreground uppercase">
            {question.header}
          </span>
          {isMultiSelect ? (
            <span className="shrink-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              Select all that apply
            </span>
          ) : null}
        </button>
        {showNavigation ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {onBack && questionIndex > 0 ? (
              <StepNavButton label="Go to previous question" disabled={disabled} onClick={onBack}>
                <ChevronLeftIcon className="size-3.5" />
              </StepNavButton>
            ) : null}
            <StepNavButton
              label="Go to next question"
              disabled={disabled || !onForward || isLastQuestion}
              onClick={() => onForward?.()}
            >
              <ChevronRightIcon className="size-3.5" />
            </StepNavButton>
          </div>
        ) : null}
      </div>
      <div hidden={collapsed}>
        <p className="mt-1.5 text-sm text-foreground">{question.question}</p>
        {hasOptions ? (
          <div className="mt-3 space-y-1">
            {question.options.map((option, index) => {
              const isSelected = isMultiSelect
                ? selectedSet.has(option.label)
                : selectedOptionLabels[0] === option.label;
              return (
                <OptionRow
                  key={`${question.id}:${option.label}`}
                  shortcutKey={index < 9 ? index + 1 : null}
                  label={option.label}
                  description={option.description !== option.label ? option.description : null}
                  selected={isSelected}
                  pressable={isMultiSelect}
                  disabled={disabled}
                  onClick={() => pickOption(option.label)}
                />
              );
            })}
            {hasOtherRow ? (
              <OptionRow
                shortcutKey={question.options.length < 9 ? question.options.length + 1 : null}
                label="Other…"
                description={null}
                selected={customOpen}
                pressable={isMultiSelect}
                disabled={disabled}
                onClick={toggleCustom}
              />
            ) : null}
          </div>
        ) : null}
        {customFieldOpen ? (
          <textarea
            ref={customFieldRef}
            rows={1}
            aria-label={`Other answer: ${question.question}`}
            placeholder="Type your answer…"
            className="mt-2 field-sizing-content max-h-24 min-h-8 w-full resize-none rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            disabled={disabled}
            value={customAnswer}
            onChange={(event) => onCustomAnswerChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onCustomSubmit?.();
            }}
          />
        ) : null}
        {customMode === "composer" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Or type your own answer in the composer
          </p>
        ) : null}
        {footer ? <div className="mt-3">{footer}</div> : null}
      </div>
    </div>
  );
}

function StepNavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function OptionRow({
  shortcutKey,
  label,
  description,
  selected,
  pressable,
  disabled,
  onClick,
}: {
  shortcutKey: number | null;
  label: string;
  description: string | null;
  selected: boolean;
  pressable: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      disabled={disabled}
      // The label names the choice; the description stays supplementary.
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      aria-pressed={pressable ? selected : undefined}
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-info/40 bg-info/8 text-foreground"
          : "border-transparent bg-muted/20 text-foreground hover:bg-muted/40 hover:border-border/40",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {shortcutKey !== null ? (
        <kbd
          aria-hidden="true"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-2xs font-medium tabular-nums transition-colors duration-150",
            selected
              ? "bg-info/20 text-info-foreground"
              : "bg-muted/40 text-muted-foreground group-hover:bg-muted/60 group-hover:text-foreground",
          )}
        >
          {shortcutKey}
        </kbd>
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{label}</span>
        {description ? (
          <span id={descriptionId} className="ml-2 text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-info-foreground" /> : null}
    </button>
  );
}
