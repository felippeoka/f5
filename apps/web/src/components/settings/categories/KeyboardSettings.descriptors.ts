import type { SettingsItemDescriptor } from "../settingsSearch";

export const KEYBOARD_SETTINGS_DESCRIPTORS = [
  {
    id: "keyboard.keybindings",
    category: "keyboard",
    label: "Keybindings",
    description: "Review keyboard shortcuts and edit the persisted keybindings file.",
    keywords: ["shortcuts", "commands", "keyboard", "keybindings.json"],
    targetSelector: '[data-settings-search-target="keyboard.keybindings"]',
  },
  {
    id: "keyboard.search",
    category: "keyboard",
    label: "Search keybindings",
    description: "Find a keyboard shortcut by command, key, or context.",
    keywords: ["shortcuts", "commands", "keyboard", "conflicts"],
    targetSelector: '[aria-label="Search keybindings"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
