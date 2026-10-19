import type { SettingsItemDescriptor } from "../settingsSearch";

/** The project-scope "Project" page: settings that belong to one project only. */
export const PROJECT_SETTINGS_DESCRIPTORS = [
  {
    id: "project.providers",
    category: "project",
    label: "Project providers",
    description: "Enable or disable configured provider instances for this project.",
    keywords: ["agent", "model", "enable", "disable"],
    targetSelector: '[data-settings-search-target="project.providers"]',
    scope: "project",
  },
  {
    id: "project.icon",
    category: "project",
    label: "Project icon",
    description: "Choose an automatic favicon, emoji, or colored symbol for a project.",
    keywords: ["favicon", "emoji", "symbol", "color", "monogram"],
    targetSelector: '[data-settings-search-target="project.icon"]',
    scope: "project",
  },
  {
    id: "project.memory",
    category: "project",
    label: "Project memory",
    description: "Store persistent instructions and context for a project.",
    keywords: ["feedback", "context", "reference", "instructions"],
    targetSelector: '[data-settings-search-target="project.memory"]',
    scope: "project",
  },
  {
    id: "project.checked-in",
    category: "project",
    label: "Checked-in configuration",
    description: "Review the defaults this repository's f5.json provides.",
    keywords: ["f5.json", "t3.json", "repository", "checked in"],
    targetSelector: '[data-settings-search-target="project.checked-in"]',
    scope: "project",
  },
  {
    id: "project.reset",
    category: "project",
    label: "Reset project overrides",
    description: "Remove every override for this project and use the global settings again.",
    keywords: ["reset", "clear", "overrides", "defaults"],
    targetSelector: '[data-settings-search-target="project.reset"]',
    scope: "project",
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
