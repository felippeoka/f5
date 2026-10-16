import { ProjectId } from "@t3tools/contracts";
import {
  ArchiveIcon,
  BellIcon,
  BotIcon,
  FolderCogIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  HardDriveIcon,
  InfoIcon,
  KeyboardIcon,
  ListTreeIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";

import { ABOUT_SETTINGS_DESCRIPTORS } from "./categories/AboutSettings.descriptors";
import { ACCOUNTS_SETTINGS_DESCRIPTORS } from "./categories/AccountsSettings.descriptors";
import { APPEARANCE_SETTINGS_DESCRIPTORS } from "./categories/AppearanceSettings.descriptors";
import { ARCHIVE_SETTINGS_DESCRIPTORS } from "./categories/ArchiveSettings.descriptors";
import { BROWSER_SETTINGS_DESCRIPTORS } from "./categories/BrowserComputerSettings.descriptors";
import { CONVERSATION_SETTINGS_DESCRIPTORS } from "./categories/ConversationSettings.descriptors";
import { GENERAL_SETTINGS_DESCRIPTORS } from "./categories/GeneralSettings.descriptors";
import { GIT_SETTINGS_DESCRIPTORS } from "./categories/GitSettings.descriptors";
import { KEYBOARD_SETTINGS_DESCRIPTORS } from "./categories/KeyboardSettings.descriptors";
import { NOTIFICATIONS_SETTINGS_DESCRIPTORS } from "./categories/NotificationsSettings.descriptors";
import { PROJECT_SETTINGS_DESCRIPTORS } from "./categories/ProjectSettings.descriptors";
import { PROJECTS_SETTINGS_DESCRIPTORS } from "./categories/ProjectsSettings.descriptors";
import { PROVIDERS_SETTINGS_DESCRIPTORS } from "./categories/ProvidersSettings.descriptors";
import { STORAGE_SETTINGS_DESCRIPTORS } from "./categories/StorageSettings.descriptors";
import { THREADS_SETTINGS_DESCRIPTORS } from "./categories/ThreadsSettings.descriptors";
import { TOOLS_SETTINGS_DESCRIPTORS } from "./categories/ToolsSettings.descriptors";
import {
  searchSettingsItems,
  settingsItemVisibleInScope,
  type SettingsItemDescriptor,
} from "./settingsSearch";

export const SETTINGS_CATEGORIES = [
  "general",
  "appearance",
  "conversation",
  "keyboard",
  "notifications",
  "providers",
  "threads",
  "tools",
  "browser",
  "projects",
  "git",
  "accounts",
  "storage",
  "archive",
  "about",
  // Only exists while a project scope is selected.
  "project",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export type SettingsScope = "global" | "project";

/** Categories rendered in global scope, in navigation order. */
export const GLOBAL_SETTINGS_CATEGORIES = SETTINGS_CATEGORIES.filter(
  (category): category is Exclude<SettingsCategory, "project"> => category !== "project",
);

/** Categories that have project content, in project-scope navigation order. */
export const PROJECT_SETTINGS_CATEGORIES = [
  "project",
  "threads",
  "tools",
  "browser",
  "git",
] as const satisfies ReadonlyArray<SettingsCategory>;

export type ProjectSettingsCategory = (typeof PROJECT_SETTINGS_CATEGORIES)[number];

export interface SettingsCategoryGroup {
  readonly id: "interface" | "agents" | "workspace" | "account" | "about" | "project" | "overrides";
  /** null renders the group without a heading (About stands alone). */
  readonly label: string | null;
  readonly categories: ReadonlyArray<SettingsCategory>;
}

/** Global-scope navigation groups, in `GLOBAL_SETTINGS_CATEGORIES` order. */
export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<SettingsCategoryGroup> = [
  {
    id: "interface",
    label: "Interface",
    categories: ["general", "appearance", "conversation", "keyboard", "notifications"],
  },
  { id: "agents", label: "Agents", categories: ["providers", "threads", "tools", "browser"] },
  { id: "workspace", label: "Workspace", categories: ["projects", "git"] },
  { id: "account", label: "Account & data", categories: ["accounts", "storage", "archive"] },
  { id: "about", label: null, categories: ["about"] },
];

/** Project-scope navigation groups, in `PROJECT_SETTINGS_CATEGORIES` order. */
export const PROJECT_SETTINGS_CATEGORY_GROUPS: ReadonlyArray<SettingsCategoryGroup> = [
  { id: "project", label: null, categories: ["project"] },
  { id: "overrides", label: "Overrides", categories: ["threads", "tools", "browser", "git"] },
];

export function settingsCategoryGroupsForScope(
  scope: SettingsScope,
): ReadonlyArray<SettingsCategoryGroup> {
  return scope === "project" ? PROJECT_SETTINGS_CATEGORY_GROUPS : SETTINGS_CATEGORY_GROUPS;
}

export function settingsCategoriesForScope(scope: SettingsScope): ReadonlyArray<SettingsCategory> {
  return scope === "project" ? PROJECT_SETTINGS_CATEGORIES : GLOBAL_SETTINGS_CATEGORIES;
}

export function isProjectSettingsCategory(
  category: SettingsCategory,
): category is ProjectSettingsCategory {
  return (PROJECT_SETTINGS_CATEGORIES as readonly string[]).includes(category);
}

export const SETTINGS_CATEGORY_ICONS = {
  general: SlidersHorizontalIcon,
  appearance: PaletteIcon,
  conversation: MessageSquareTextIcon,
  keyboard: KeyboardIcon,
  notifications: BellIcon,
  providers: BotIcon,
  threads: ListTreeIcon,
  tools: WrenchIcon,
  browser: GlobeIcon,
  projects: FolderIcon,
  git: GitBranchIcon,
  accounts: UsersIcon,
  storage: HardDriveIcon,
  archive: ArchiveIcon,
  about: InfoIcon,
  project: FolderCogIcon,
} as const satisfies Record<SettingsCategory, LucideIcon>;

export const SETTINGS_CATEGORY_LABELS = {
  general: "General",
  appearance: "Appearance",
  conversation: "Conversation",
  keyboard: "Keyboard",
  notifications: "Notifications",
  providers: "Providers",
  threads: "Threads",
  tools: "Tools",
  browser: "Browser & Computer",
  projects: "Projects",
  git: "Git & GitHub",
  accounts: "Profiles & Accounts",
  storage: "Storage",
  archive: "Archive",
  about: "About",
  project: "Project",
} as const satisfies Record<SettingsCategory, string>;

export const SETTINGS_ITEM_DESCRIPTORS: ReadonlyArray<SettingsItemDescriptor> = [
  ...GENERAL_SETTINGS_DESCRIPTORS,
  ...APPEARANCE_SETTINGS_DESCRIPTORS,
  ...CONVERSATION_SETTINGS_DESCRIPTORS,
  ...KEYBOARD_SETTINGS_DESCRIPTORS,
  ...NOTIFICATIONS_SETTINGS_DESCRIPTORS,
  ...PROVIDERS_SETTINGS_DESCRIPTORS,
  ...THREADS_SETTINGS_DESCRIPTORS,
  ...TOOLS_SETTINGS_DESCRIPTORS,
  ...BROWSER_SETTINGS_DESCRIPTORS,
  ...PROJECTS_SETTINGS_DESCRIPTORS,
  ...GIT_SETTINGS_DESCRIPTORS,
  ...ACCOUNTS_SETTINGS_DESCRIPTORS,
  ...STORAGE_SETTINGS_DESCRIPTORS,
  ...ARCHIVE_SETTINGS_DESCRIPTORS,
  ...ABOUT_SETTINGS_DESCRIPTORS,
  ...PROJECT_SETTINGS_DESCRIPTORS,
];

const SETTINGS_ITEM_BY_ID = new Map<string, SettingsItemDescriptor>();
for (const descriptor of SETTINGS_ITEM_DESCRIPTORS) {
  if (SETTINGS_ITEM_BY_ID.has(descriptor.id)) {
    throw new Error(`Duplicate settings item descriptor: ${descriptor.id}`);
  }
  SETTINGS_ITEM_BY_ID.set(descriptor.id, descriptor);
}

/** Category names from before the settings reorganization, kept so old deep links resolve. */
export const LEGACY_SETTINGS_CATEGORY_ALIASES: Readonly<Record<string, SettingsCategory>> = {
  display: "conversation",
  integrations: "tools",
  profiles: "accounts",
};

/** Item IDs from before the settings reorganization, kept so old deep links resolve. */
export const LEGACY_SETTINGS_ITEM_ALIASES: Readonly<Record<string, string>> = {
  "general.theme": "appearance.theme",
  // General
  "general.composer-collapse": "conversation.composer-collapse",
  "general.composer-editor": "conversation.composer-editor",
  "general.send-shortcut": "conversation.send-shortcut",
  "general.pr-merge-method": "git.merge-method",
  "general.default-worktree": "threads.default-workspace",
  // Display
  "display.diff-default": "conversation.diff-default",
  "display.diff-colors": "appearance.diff-colors",
  "display.streaming": "conversation.streaming",
  "display.file-links": "general.file-links",
  "display.word-wrap": "conversation.word-wrap",
  "display.file-tree-limit": "general.file-tree-limit",
  "display.work-log-detail": "conversation.work-log-detail",
  "display.work-log-category": "conversation.work-log-category",
  "display.workflow-expand": "conversation.workflow-expand",
  "display.command-output": "conversation.command-output",
  "display.command-expand": "conversation.command-expand",
  "display.mcp-details": "conversation.mcp-details",
  "display.mcp-expand": "conversation.mcp-expand",
  "display.reasoning": "conversation.reasoning",
  "display.inline-diffs": "conversation.inline-diffs",
  "display.runtime-warnings": "conversation.runtime-warnings",
  "display.provider-metadata": "conversation.provider-metadata",
  "display.sidebar-preview": "general.sidebar-preview",
  // Notifications
  "notifications.git-refresh": "git.status-refresh",
  "notifications.git-refresh-interval": "git.status-refresh-interval",
  "notifications.pr-refresh": "git.pr-refresh",
  "notifications.pr-refresh-interval": "git.pr-refresh-interval",
  "notifications.pr-stalled": "git.pr-stalled",
  "notifications.pr-discovery": "git.pr-discovery",
  // Providers & Models
  "providers.session-notes": "threads.summaries",
  "providers.codex-binary": "providers.instances",
  "providers.codex-home": "providers.instances",
  "providers.claude-binary": "providers.instances",
  "providers.claude-args": "providers.instances",
  "providers.custom-models": "providers.instances",
  "providers.git-model": "git.text-model",
  "providers.source-control-writing": "git.writing",
  // Integrations
  "integrations.browser": "browser.agent-access",
  "integrations.github": "accounts.github",
  "integrations.agent-bridge": "tools.agent-bridge",
  "integrations.keybindings": "keyboard.keybindings",
  "integrations.search-keybindings": "keyboard.search",
  "integrations.mcp": "tools.mcp",
  // Projects
  "projects.active-project": "projects.list",
  "projects.default-env-mode": "threads.default-workspace",
  "projects.icon": "project.icon",
  "projects.memory": "project.memory",
  "projects.claude-subagents": "threads.claude-subagents",
  "projects.claude-subagent-model": "threads.claude-subagent-model",
  // Profiles
  "profiles.manage": "accounts.profiles",
  "profiles.accounts": "accounts.providers",
  "profiles.storage": "accounts.storage",
  // Storage
  "storage.auto-pull": "git.auto-pull",
};

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** Canonical category for a current or legacy category name, or null. */
export function resolveSettingsCategoryAlias(value: unknown): SettingsCategory | null {
  if (isSettingsCategory(value)) return value;
  if (typeof value !== "string") return null;
  return Object.hasOwn(LEGACY_SETTINGS_CATEGORY_ALIASES, value)
    ? LEGACY_SETTINGS_CATEGORY_ALIASES[value]!
    : null;
}

export function getSettingsItemDescriptor(value: unknown): SettingsItemDescriptor | null {
  if (typeof value !== "string") return null;
  const canonicalId = Object.hasOwn(LEGACY_SETTINGS_ITEM_ALIASES, value)
    ? LEGACY_SETTINGS_ITEM_ALIASES[value]!
    : value;
  return SETTINGS_ITEM_BY_ID.get(canonicalId) ?? null;
}

export function isSettingsItemId(value: unknown): value is string {
  return getSettingsItemDescriptor(value) !== null;
}

export function filterSettingsItems(
  query: string,
  options: { readonly limit?: number; readonly scope?: SettingsScope } = {},
): SettingsItemDescriptor[] {
  const scope = options.scope ?? "global";
  return searchSettingsItems(
    SETTINGS_ITEM_DESCRIPTORS.filter((descriptor) => settingsItemVisibleInScope(descriptor, scope)),
    query,
    options.limit,
  );
}

/** Reads the project scope, accepting the pre-reorganization `projectId` param as well. */
export function resolveSettingsProjectIdFromSearch(search: unknown): ProjectId | undefined {
  const rawSearch = search as { project?: unknown; projectId?: unknown } | null | undefined;
  for (const raw of [rawSearch?.project, rawSearch?.projectId]) {
    if (typeof raw === "string" && raw.length > 0 && raw.length <= 256) {
      return ProjectId.makeUnsafe(raw);
    }
  }
  return undefined;
}

export interface SettingsSearch {
  readonly category: SettingsCategory;
  readonly item?: string;
  readonly project?: ProjectId;
}

/**
 * Canonical settings search for any raw search object. Resolves legacy category
 * and item names, and keeps the project scope only when the destination exists
 * in project scope.
 */
export function resolveSettingsSearch(search: unknown): SettingsSearch {
  const rawSearch = search as { category?: unknown; item?: unknown } | null | undefined;
  const project = resolveSettingsProjectIdFromSearch(search);
  const item = getSettingsItemDescriptor(rawSearch?.item);
  if (item) {
    const itemScope = item.scope ?? "global";
    if (itemScope === "project" && !project) return { category: "projects" };
    return {
      category: item.category,
      item: item.id,
      ...(project && itemScope !== "global" ? { project } : {}),
    };
  }

  const category = resolveSettingsCategoryAlias(rawSearch?.category);
  if (project) {
    if (category === null || category === "projects") return { category: "project", project };
    if (isProjectSettingsCategory(category)) return { category, project };
    return { category };
  }
  if (category === null) return { category: "general" };
  if (category === "project") return { category: "projects" };
  return { category };
}

export function resolveSettingsCategoryFromSearch(search: unknown): SettingsCategory {
  return resolveSettingsSearch(search).category;
}

export function resolveSettingsNavigationSearch(input: {
  readonly pathname: string;
  readonly search: unknown;
}): SettingsSearch {
  if (input.pathname === "/settings") return resolveSettingsSearch(input.search);
  return { category: "general" };
}
