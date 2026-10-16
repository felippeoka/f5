import type { SettingsItemDescriptor } from "../settingsSearch";

export const ACCOUNTS_SETTINGS_DESCRIPTORS = [
  {
    id: "accounts.profiles",
    category: "accounts",
    label: "Profiles",
    description: "Isolated accounts, projects and chat history.",
    keywords: ["work", "personal", "account", "environment", "port", "new profile"],
    targetSelector: '[data-settings-search-target="accounts.profiles"]',
  },
  {
    id: "accounts.providers",
    category: "accounts",
    label: "Provider accounts",
    description: "Sign in to the CLIs this profile uses.",
    keywords: ["sign in", "sign out", "login", "logout", "codex", "claude", "authentication"],
    targetSelector: '[data-settings-search-target="accounts.providers"]',
  },
  {
    id: "accounts.github",
    category: "accounts",
    label: "GitHub account",
    description: "Sign in to GitHub for this profile’s agents, terminals, and pull requests.",
    keywords: ["github", "gh", "authentication", "login", "token"],
    targetSelector: '[data-settings-search-target="accounts.github"]',
  },
  {
    id: "accounts.storage",
    category: "accounts",
    label: "Profile storage",
    description: "Where profile data and removed profiles are kept on disk.",
    keywords: ["trash", "disk", "folder", "directory", "state"],
    targetSelector: '[data-settings-search-target="accounts.storage"]',
  },
] satisfies readonly SettingsItemDescriptor[];
