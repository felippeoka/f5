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
  {
    id: "tools.agent-bridge",
    category: "tools",
    label: "Agent Bridge",
    description:
      "Let external agents such as a ChatGPT Dot read shared projects and start supervised threads.",
    keywords: ["mcp", "dots", "chatgpt", "agents", "bots", "stdio", "bridge"],
    targetSelector: '[data-settings-search-target="tools.agent-bridge"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
