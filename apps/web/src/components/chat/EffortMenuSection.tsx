import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ZapIcon } from "lucide-react";
import { useState, type FocusEvent } from "react";

import { cn } from "~/lib/utils";
import { MenuGroup } from "../ui/menu";
import { getEffortLevel, sortEffortOptions } from "./effortLevels";

export interface EffortMenuOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean | undefined;
}

/** Row content for a Fast mode switch: the zap lights up amber while it's on. */
export function FastModeLabel(props: { enabled: boolean; label?: string }) {
  return (
    <span className="flex items-center gap-2">
      <ZapIcon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          props.enabled ? "fill-warning text-warning" : "text-muted-foreground",
        )}
      />
      {props.label ?? "Fast Mode"}
    </span>
  );
}

/** Amber zap shown in a traits trigger chip while Fast mode is on. */
export function FastModeTriggerIcon() {
  return (
    <ZapIcon aria-label="Fast mode enabled" className="size-3 shrink-0 fill-warning text-warning" />
  );
}

function focusedEffortLevel(event: FocusEvent<HTMLElement>): string | null {
  if (!(event.target instanceof HTMLElement)) return null;
  return event.target.closest<HTMLElement>("[data-effort-level]")?.dataset.effortLevel ?? null;
}

/**
 * Reasoning effort as a ranked "battery": highest level at the top, one
 * coloured segment per row, filled from the lowest level up to the selected
 * one. Highlighting a row (pointer or keyboard) previews its fill.
 */
export function EffortMenuSection(props: {
  options: ReadonlyArray<EffortMenuOption>;
  value: string | null;
  onValueChange: (value: string) => void;
  header?: string;
}) {
  const [previewLevel, setPreviewLevel] = useState<string | null>(null);
  const options = sortEffortOptions(props.options);
  const selectedIndex = options.findIndex((option) => option.id === props.value);
  const previewIndex = options.findIndex((option) => option.id === previewLevel);
  // Rows are top-down, so a row is filled when it sits at or below the fill line.
  const fillIndex = previewIndex >= 0 ? previewIndex : selectedIndex;

  return (
    <MenuGroup
      onFocus={(event: FocusEvent<HTMLElement>) => setPreviewLevel(focusedEffortLevel(event))}
      onBlur={(event: FocusEvent<HTMLElement>) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setPreviewLevel(null);
        }
      }}
    >
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
        {props.header ?? "Reasoning effort"}
      </div>
      <MenuPrimitive.RadioGroup
        data-slot="menu-radio-group"
        value={props.value ?? ""}
        onValueChange={(value: unknown) => {
          if (typeof value === "string" && value) props.onValueChange(value);
        }}
      >
        {options.map((option, index) => {
          const level = getEffortLevel(option.id);
          const selected = index === selectedIndex;
          const filled = fillIndex >= 0 && index >= fillIndex;
          return (
            <MenuPrimitive.RadioItem
              key={option.id}
              value={option.id}
              aria-label={`${option.label}${option.isDefault ? " (default)" : ""}`}
              data-effort-level={option.id}
              data-slot="menu-radio-item"
              className="flex min-h-8 cursor-default items-center gap-2.5 rounded-sm py-0.5 ps-1.5 pe-2 text-base text-foreground outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm"
            >
              <span
                aria-hidden="true"
                data-effort-filled={filled}
                className={cn(
                  "h-6 w-3.5 shrink-0 rounded-xs transition-[background-color,box-shadow] duration-150",
                  index === 0 && "rounded-t-md",
                  index === options.length - 1 && "rounded-b-md",
                  filled ? level?.segmentClass : "bg-foreground/10",
                  selected && level?.glowClass,
                )}
              />
              <span
                className={cn("flex-1 truncate", selected && ["font-semibold", level?.textClass])}
              >
                {option.label}
              </span>
              {level ? (
                <span aria-hidden="true" className="ms-4 shrink-0 text-muted-foreground text-xs">
                  {option.isDefault ? `Default · ${level.tag}` : level.tag}
                </span>
              ) : null}
            </MenuPrimitive.RadioItem>
          );
        })}
      </MenuPrimitive.RadioGroup>
    </MenuGroup>
  );
}
