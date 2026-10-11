import type { CodexMcpServerEntry } from "@t3tools/contracts";

const CODEX_TELEMETRY_DISABLED_CONFIG_ARGS = [
  "-c",
  "analytics.enabled=false",
  "-c",
  'otel.exporter="none"',
  "-c",
  'otel.metrics_exporter="none"',
  "-c",
  'otel.trace_exporter="none"',
] as const satisfies ReadonlyArray<string>;

function encodeTomlInlineValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeTomlInlineValue(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${encodeTomlInlineValue(entry)}`)
      .join(",")}}`;
  }
  return "{}";
}

/**
 * Codex infers an MCP server's transport from `command` vs `url` and warns
 * about unknown keys, so F5's internal `type` discriminant stays out of argv.
 */
function toCodexCliMcpServers(
  servers: Record<string, CodexMcpServerEntry>,
): Record<string, Omit<CodexMcpServerEntry, "type">> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, { type: _type, ...entry }]) => [name, entry]),
  );
}

export function buildCodexCliMcpConfigArgs(
  servers: Record<string, CodexMcpServerEntry> | null | undefined,
  options?: {
    readonly mcpOAuthCallbackPort?: number | null;
    readonly mcpOAuthCallbackUrl?: string | null;
  },
): ReadonlyArray<string> {
  const callbackPort = options?.mcpOAuthCallbackPort;
  const callbackUrl = options?.mcpOAuthCallbackUrl?.trim();
  return [
    "-c",
    `mcp_servers=${encodeTomlInlineValue(toCodexCliMcpServers(servers ?? {}))}`,
    ...(typeof callbackPort === "number" &&
    Number.isInteger(callbackPort) &&
    callbackPort > 0 &&
    callbackPort <= 65535
      ? ["-c", `mcp_oauth_callback_port=${callbackPort}`]
      : []),
    ...(callbackUrl ? ["-c", `mcp_oauth_callback_url=${encodeTomlInlineValue(callbackUrl)}`] : []),
  ];
}

export function prependCodexCliTelemetryDisabledConfig(
  args: ReadonlyArray<string>,
  options?: {
    readonly managedCredentials?: boolean;
    readonly mcpServers?: Record<string, CodexMcpServerEntry> | null;
    readonly mcpOAuthCallbackPort?: number | null;
    readonly mcpOAuthCallbackUrl?: string | null;
  },
): ReadonlyArray<string> {
  return [
    ...CODEX_TELEMETRY_DISABLED_CONFIG_ARGS,
    ...(options?.managedCredentials ? ["-c", 'cli_auth_credentials_store="file"'] : []),
    ...buildCodexCliMcpConfigArgs(
      options?.mcpServers,
      options?.mcpOAuthCallbackPort || options?.mcpOAuthCallbackUrl
        ? {
            ...(options.mcpOAuthCallbackPort
              ? { mcpOAuthCallbackPort: options.mcpOAuthCallbackPort }
              : {}),
            ...(options.mcpOAuthCallbackUrl
              ? { mcpOAuthCallbackUrl: options.mcpOAuthCallbackUrl }
              : {}),
          }
        : {},
    ),
    ...args,
  ];
}
