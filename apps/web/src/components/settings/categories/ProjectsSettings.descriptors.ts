import type { SettingsItemDescriptor } from "../settingsSearch";

export const PROJECTS_SETTINGS_DESCRIPTORS = [
  {
    id: "projects.base-directory",
    category: "projects",
    label: "Add-project base directory",
    description: "Choose the starting directory used when adding a project.",
    keywords: ["folder", "path", "workspace", "command palette"],
    targetSelector: "#add-project-base-directory",
  },
  {
    id: "projects.list",
    category: "projects",
    label: "Project settings",
    description: "Open a project's icon, memory, and overrides.",
    keywords: ["project", "configure", "override", "scope", "icon", "memory"],
    targetSelector: '[data-settings-search-target="projects.list"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
