import type { SettingsItemDescriptor } from "../settingsSearch";

export const TOOLS_SETTINGS_DESCRIPTORS = [
  {
    id: "tools.mcp",
    category: "tools",
    label: "MCP servers",
    description: "Configure common and project-scoped Model Context Protocol servers.",
    keywords: ["tools", "model context protocol", "stdio", "http", "server"],
    targetSelector: '[data-settings-search-target="tools.mcp"]',
    scope: "both",
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
