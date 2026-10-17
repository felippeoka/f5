import { useSettingsRouteContext } from "../SettingsRouteContext";
import { McpServersSettings } from "../McpServersSettings";

export { TOOLS_SETTINGS_DESCRIPTORS } from "./ToolsSettings.descriptors";

/** Global Tools page. Project MCP servers are edited from the project scope. */
export function ToolsSettings() {
  const { hasProjects, settings } = useSettingsRouteContext();

  return (
    <McpServersSettings
      selectedProject={null}
      hasProjects={hasProjects}
      codexBinaryPath={settings.codexBinaryPath}
      codexHomePath={settings.codexHomePath}
      claudeBinaryPath={settings.claudeBinaryPath}
    />
  );
}
