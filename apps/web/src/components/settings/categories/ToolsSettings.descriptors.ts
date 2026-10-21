import type { SettingsItemDescriptor } from "../settingsSearch";

export const TOOLS_SETTINGS_DESCRIPTORS = [
  {
    id: "tools.agent-bridge",
    category: "tools",
    label: "Agent Bridge",
    description: "Connect a local MCP client and explicitly grant scheduled task access.",
    keywords: ["schedules", "MCP", "local", "agent", "permissions"],
    targetSelector: '[data-settings-search-target="tools.agent-bridge"]',
    scope: "global",
  },
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
