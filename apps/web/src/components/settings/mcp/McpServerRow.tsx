import { McpTestConnection } from "./McpTestConnection";
import { reconnectMcpServer } from "./mcpActions";
import { LazyMcpServerInspector as McpServerInspector } from "./LazyMcpServerInspector";
import type {
  ProviderKind,
  ProviderInstanceId,
  ProjectId,
  McpProjectServersConfig,
  McpProviderStatusResult,
  McpServerStatusEntry,
  McpServerStatusesResult,
  McpSessionReloadOutcome,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ensureNativeApi } from "../../../nativeApi";
import { mcpLoginStatusQueryOptions, mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { McpServerStatusBadge } from "./McpStatus";
import { readErrorMessage } from "./mcpSettingsHelpers";

export function McpServerRow(props: {
  readonly onToolToggle?: ((toolName: string, enabled: boolean) => Promise<void>) | undefined;
  readonly selectedProvider: ProviderKind;
  readonly observation?: McpServerStatusesResult | undefined;
  readonly outcomes?: ReadonlyArray<McpSessionReloadOutcome> | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId | null;
  readonly name: string;
  readonly server: McpProjectServersConfig[string];
  readonly providerStatus: McpProviderStatusResult | undefined;
  readonly serverStatus: McpServerStatusEntry | undefined;
  readonly codexCallbackSummary: string | null;
  readonly isOverridden: boolean;
  readonly overrideTargetEnabled: boolean | undefined;
  readonly onToggleEnabled: (checked: boolean) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const [probeTools, setProbeTools] = useState<{
    config: string;
    tools: import("@t3tools/contracts").McpToolSummary[];
  }>();
  const probeConfig = JSON.stringify({
    ...props.server,
    enabledTools: undefined,
    disabledTools: undefined,
    enabled: undefined,
  });
  const [toolsOpenCount, setToolsOpenCount] = useState(0);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectOutcomes, setReconnectOutcomes] =
    useState<ReadonlyArray<McpSessionReloadOutcome>>();
  const [loginError, setLoginError] = useState<string | null>(null);
  const loginStatusQuery = useQuery(
    mcpLoginStatusQueryOptions({
      provider: props.selectedProvider,
      instanceId: props.instanceId,
      projectId: props.projectId,
      serverName: props.selectedProvider === "codex" ? props.name : null,

      enabled:
        props.selectedProvider === "codex" && props.projectId !== null && !props.isOverridden,
    }),
  );

  const isCodexProvider = props.selectedProvider === "codex";
  const supportsCodexOauthLogin =
    props.server.type === "http" ||
    typeof props.server.oauthClientId === "string" ||
    typeof props.server.oauthCallbackPort === "number" ||
    typeof props.server.oauthCallbackUrl === "string" ||
    typeof props.server.oauthResource === "string";
  const loginModeHint = loginStatusQuery.data?.mode ?? (supportsCodexOauthLogin ? "oauth" : "cli");
  const shouldShowLoginAction =
    isCodexProvider &&
    !props.isOverridden &&
    (props.serverStatus?.state === "login-required" ||
      props.serverStatus?.state === "needs-auth" ||
      (supportsCodexOauthLogin && props.serverStatus?.state === "failed") ||
      loginStatusQuery.data?.status === "pending" ||
      loginStatusQuery.data?.status === "failed");
  const loginDisabledReason = !isCodexProvider
    ? null
    : props.projectId === null
      ? "Select a project to manage shared MCP login."
      : props.isOverridden
        ? props.overrideTargetEnabled === false
          ? "This common-scope entry is overridden by a disabled project-scoped server with the same name."
          : "This common-scope entry is overridden by a project-scoped server with the same name."
        : props.server.enabled === false
          ? "Enable this server before starting MCP login."
          : props.providerStatus?.support !== "supported"
            ? "Codex MCP login requires MCP control/status support."
            : null;

  const loginButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={loginDisabledReason !== null || loginStatusQuery.data?.status === "pending"}
      onClick={() => {
        if (!props.projectId || loginDisabledReason !== null) {
          return;
        }
        setLoginError(null);
        void ensureNativeApi()
          .mcp.startLogin({
            provider: props.selectedProvider,
            instanceId: props.instanceId,
            projectId: props.projectId,
            serverName: props.name,
          })
          .then(async (result) => {
            if (result.authorizationUrl) {
              await ensureNativeApi()
                .shell.openExternal(result.authorizationUrl)
                .catch(() =>
                  setLoginError(
                    "Could not open the browser. Sign-in is still pending; use Reopen sign-in.",
                  ),
                );
            }
          })
          .catch((error) => {
            setLoginError(readErrorMessage(error, "Failed to start MCP login."));
          })
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
          });
      }}
    >
      {loginStatusQuery.data?.status === "pending"
        ? loginModeHint === "oauth"
          ? "Connecting..."
          : "Logging in..."
        : loginModeHint === "oauth"
          ? "Connect"
          : "Login"}
    </Button>
  );

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{props.name.trim()}</p>
            <Badge variant="outline">{props.server.type}</Badge>
            <Badge variant="outline">
              Saved: {props.server.enabled === false ? "Disabled" : "Enabled"}
            </Badge>
            <McpServerStatusBadge
              provider={props.selectedProvider}
              status={props.serverStatus}
              loginStatus={loginStatusQuery.data}
              isOverridden={props.isOverridden}
            />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {props.server.type === "stdio" ? props.server.command : props.server.url}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
            <span className="text-2xs text-muted-foreground">Enabled</span>
            <Switch
              checked={props.server.enabled !== false}
              onCheckedChange={(checked) => props.onToggleEnabled(Boolean(checked))}
              aria-label={`Enable MCP server ${props.name}`}
            />
          </div>
          {isCodexProvider && shouldShowLoginAction ? (
            loginDisabledReason ? (
              <Tooltip>
                <TooltipTrigger render={loginButton} />
                <TooltipPopup side="top">{loginDisabledReason}</TooltipPopup>
              </Tooltip>
            ) : (
              loginButton
            )
          ) : null}
          {props.projectId && !props.isOverridden ? (
            <>
              <Button size="xs" variant="outline" onClick={() => setInspectorOpen((open) => !open)}>
                {inspectorOpen ? "Close inspector" : "Inspect"}
              </Button>
              {["failed", "needs-auth", "login-required", "unknown"].includes(
                props.serverStatus?.state ?? "",
              ) ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={reconnecting}
                  title={
                    isCodexProvider
                      ? "Reloads MCP connections for every server in the affected Codex sessions."
                      : undefined
                  }
                  onClick={() => {
                    setReconnecting(true);
                    setLoginError(null);
                    void reconnectMcpServer(queryClient, {
                      provider: props.selectedProvider,
                      instanceId: props.instanceId,
                      projectId: props.projectId!,
                      serverName: props.name,
                    })
                      .then((result) => setReconnectOutcomes(result.sessions))
                      .catch((error) => setLoginError(readErrorMessage(error, "Reconnect failed.")))
                      .finally(() => setReconnecting(false));
                  }}
                >
                  {reconnecting ? "Reconnecting…" : "Reconnect"}
                </Button>
              ) : null}
            </>
          ) : null}
          <Button size="xs" variant="outline" onClick={props.onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="outline" onClick={props.onRemove}>
            Remove
          </Button>
        </div>
      </div>
      {loginStatusQuery.data?.status === "pending" && loginStatusQuery.data.authorizationUrl ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void ensureNativeApi()
              .shell.openExternal(loginStatusQuery.data!.authorizationUrl!)
              .catch((error) =>
                setLoginError(
                  readErrorMessage(error, "Could not open sign-in. The login is still pending."),
                ),
              );
          }}
        >
          Reopen sign-in
        </Button>
      ) : null}
      {loginError ? <p className="text-xs text-destructive">{loginError}</p> : null}
      {loginStatusQuery.data?.error ? (
        <p className="text-xs text-destructive">{loginStatusQuery.data.error}</p>
      ) : null}
      {loginStatusQuery.data?.message ? (
        <p className="text-xs text-muted-foreground">{loginStatusQuery.data.message}</p>
      ) : null}
      {loginStatusQuery.error ? (
        <p className="text-xs text-destructive">
          {readErrorMessage(loginStatusQuery.error, "Failed to read MCP login status.")}
        </p>
      ) : null}
      <McpTestConnection
        projectId={props.projectId}
        instanceId={props.instanceId}
        getServer={() => ({ name: props.name, server: props.server })}
        onResult={(result) => setProbeTools({ config: probeConfig, tools: [...result.tools] })}
        onOpenTools={() => {
          setToolsOpenCount((count) => count + 1);
          setInspectorOpen(true);
        }}
      />
      {inspectorOpen && props.projectId ? (
        <McpServerInspector
          key={`${props.observation?.threadId}:${props.observation?.generation}:${toolsOpenCount}`}
          initialTab={toolsOpenCount ? "Tools" : "Overview"}
          provider={props.selectedProvider}
          instanceId={props.instanceId}
          projectId={props.projectId}
          serverName={props.name}
          configuredServer={props.server}
          onToolToggle={props.onToolToggle}
          fallbackTools={
            probeTools?.config === probeConfig ? probeTools.tools : props.serverStatus?.tools
          }
          observation={props.observation}
          outcomes={reconnectOutcomes ?? props.outcomes}
          outcomeAction={reconnectOutcomes ? "reconnect" : "apply"}
        />
      ) : null}
      {props.serverStatus?.message ? (
        <p className="text-xs text-muted-foreground">{props.serverStatus.message}</p>
      ) : null}
      {props.codexCallbackSummary ? (
        <p className="text-xs text-muted-foreground">{props.codexCallbackSummary}</p>
      ) : null}
      {props.isOverridden ? (
        <p className="text-xs text-muted-foreground">
          {props.overrideTargetEnabled === false
            ? "This common-scope entry is overridden by the selected project, and the project-scoped server is currently disabled."
            : "This common-scope entry is overridden by the selected project. Live status and login actions apply to the project-scoped server instead."}
        </p>
      ) : null}
    </div>
  );
}
