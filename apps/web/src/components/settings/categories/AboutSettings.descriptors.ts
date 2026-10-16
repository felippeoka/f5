import type { SettingsItemDescriptor } from "../settingsSearch";

export const ABOUT_SETTINGS_DESCRIPTORS = [
  {
    id: "about.updates",
    category: "about",
    label: "Updates",
    description: "Check, download and install F5 updates.",
    keywords: ["update", "restart", "release"],
    targetSelector: '[data-settings-search-target="about.updates"]',
  },
  {
    id: "about.betaUpdates",
    category: "about",
    label: "Beta updates",
    description: "Receive pre-release builds.",
    keywords: ["beta", "channel", "prerelease"],
    targetSelector: '[data-settings-search-target="about.betaUpdates"]',
  },
  {
    id: "about.version",
    category: "about",
    label: "Application version",
    description: "View the installed F5 version and environment information.",
    keywords: ["about", "build", "release"],
    targetSelector: '[data-settings-search-target="about.version"]',
  },
  {
    id: "about.onboarding",
    category: "about",
    label: "Show onboarding again",
    description: "Restart the lightweight onboarding flow.",
    keywords: ["welcome", "setup", "tutorial"],
    targetSelector: '[data-settings-search-target="about.onboarding"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
