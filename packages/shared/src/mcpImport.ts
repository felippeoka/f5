import {
  McpServerDefinition,
  type McpProjectServersConfig,
  type McpServerTransportType as TransportType,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { normalizeMcpServersRecord } from "./mcpValidation";

// This intentionally retains the basic TOML reader; replacing it is a separate behavior change.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readImportedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readImportedBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readImportedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readImportedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function readImportedStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parsed = Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => {
        if (typeof entry !== "string") {
          return null;
        }
        const normalizedKey = key.trim();
        return normalizedKey ? ([normalizedKey, entry] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function readImportedOauthConfig(value: unknown): {
  readonly clientId?: string;
  readonly callbackPort?: number;
  readonly callbackUrl?: string;
} {
  if (!isRecord(value)) {
    return {};
  }
  const clientId =
    readImportedString(value.clientId) ??
    readImportedString(value.client_id) ??
    readImportedString(value.CLIENT_ID);
  const callbackPort =
    readImportedInteger(value.callbackPort) ?? readImportedInteger(value.callback_port);
  const callbackUrl =
    readImportedString(value.callbackUrl) ?? readImportedString(value.callback_url);
  return {
    ...(clientId ? { clientId } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

function decodeImportedServer(value: unknown): McpProjectServersConfig[string] | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawType =
    readImportedString(value.type) ??
    readImportedString(value.transport) ??
    readImportedString(value.transportType);
  if (rawType === "sdk") {
    return null;
  }

  const type: TransportType | undefined =
    rawType === "stdio" || rawType === "sse" || rawType === "http"
      ? rawType
      : readImportedString(value.command)
        ? "stdio"
        : readImportedString(value.url)
          ? "http"
          : undefined;
  if (!type) {
    return null;
  }

  const candidate =
    type === "stdio"
      ? {
          type,
          command: readImportedString(value.command),
          ...(readImportedStringArray(value.args)
            ? { args: readImportedStringArray(value.args) }
            : {}),
          ...(readImportedStringRecord(value.env)
            ? { env: readImportedStringRecord(value.env) }
            : {}),
          ...(readImportedString(value.cwd) ? { cwd: readImportedString(value.cwd) } : {}),
        }
      : {
          type,
          url: readImportedString(value.url),
          ...(readImportedStringRecord(value.headers)
            ? { headers: readImportedStringRecord(value.headers) }
            : {}),
        };

  try {
    const oauthConfig = {
      ...readImportedOauthConfig(value.auth),
      ...readImportedOauthConfig(value.oauth),
    };
    const oauthClientId =
      readImportedString(value.oauthClientId) ??
      readImportedString(value.oauth_client_id) ??
      oauthConfig.clientId;
    const oauthCallbackPort =
      readImportedInteger(value.oauthCallbackPort) ??
      readImportedInteger(value.oauth_callback_port) ??
      oauthConfig.callbackPort;
    const oauthCallbackUrl =
      readImportedString(value.oauthCallbackUrl) ??
      readImportedString(value.oauth_callback_url) ??
      oauthConfig.callbackUrl;
    return Schema.decodeUnknownSync(McpServerDefinition)({
      ...candidate,
      ...(readImportedBoolean(value.enabled) !== undefined
        ? { enabled: readImportedBoolean(value.enabled) }
        : {}),
      ...((readImportedString(value.bearerTokenEnvVar) ??
      readImportedString(value.bearer_token_env_var))
        ? {
            bearerTokenEnvVar:
              readImportedString(value.bearerTokenEnvVar) ??
              readImportedString(value.bearer_token_env_var),
          }
        : {}),
      ...((readImportedBoolean(value.supportsParallelToolCalls) ??
      readImportedBoolean(value.supports_parallel_tool_calls))
        ? {
            supportsParallelToolCalls:
              readImportedBoolean(value.supportsParallelToolCalls) ??
              readImportedBoolean(value.supports_parallel_tool_calls),
          }
        : {}),
      ...((readImportedInteger(value.startupTimeoutSec) ??
      readImportedInteger(value.startup_timeout_sec))
        ? {
            startupTimeoutSec:
              readImportedInteger(value.startupTimeoutSec) ??
              readImportedInteger(value.startup_timeout_sec),
          }
        : {}),
      ...((readImportedInteger(value.toolTimeoutSec) ?? readImportedInteger(value.tool_timeout_sec))
        ? {
            toolTimeoutSec:
              readImportedInteger(value.toolTimeoutSec) ??
              readImportedInteger(value.tool_timeout_sec),
          }
        : {}),
      ...((readImportedStringArray(value.enabledTools) ??
      readImportedStringArray(value.enabled_tools))
        ? {
            enabledTools:
              readImportedStringArray(value.enabledTools) ??
              readImportedStringArray(value.enabled_tools),
          }
        : {}),
      ...((readImportedStringArray(value.disabledTools) ??
      readImportedStringArray(value.disabled_tools))
        ? {
            disabledTools:
              readImportedStringArray(value.disabledTools) ??
              readImportedStringArray(value.disabled_tools),
          }
        : {}),
      ...(readImportedStringArray(value.scopes)
        ? { scopes: readImportedStringArray(value.scopes) }
        : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthCallbackPort !== undefined ? { oauthCallbackPort } : {}),
      ...(oauthCallbackUrl ? { oauthCallbackUrl } : {}),
      ...((readImportedString(value.oauthResource) ?? readImportedString(value.oauth_resource))
        ? {
            oauthResource:
              readImportedString(value.oauthResource) ?? readImportedString(value.oauth_resource),
          }
        : {}),
    });
  } catch {
    return null;
  }
}

function canUseTopLevelOauthCallback(value: Record<string, unknown>): boolean {
  const rawType =
    readImportedString(value.type) ??
    readImportedString(value.transport) ??
    readImportedString(value.transportType);
  return (
    value.oauth !== undefined ||
    value.auth !== undefined ||
    value.oauthClientId !== undefined ||
    value.oauth_client_id !== undefined ||
    value.oauthCallbackUrl !== undefined ||
    value.oauth_callback_url !== undefined ||
    value.oauthResource !== undefined ||
    value.oauth_resource !== undefined ||
    rawType === "http" ||
    (!rawType && readImportedString(value.url) !== undefined)
  );
}

function hasImportedServerOauthCallbackPort(value: Record<string, unknown>): boolean {
  return (
    readImportedInteger(value.oauthCallbackPort) !== undefined ||
    readImportedInteger(value.oauth_callback_port) !== undefined ||
    readImportedOauthConfig(value.auth).callbackPort !== undefined ||
    readImportedOauthConfig(value.oauth).callbackPort !== undefined
  );
}

function hasImportedServerOauthCallbackUrl(value: Record<string, unknown>): boolean {
  return (
    readImportedString(value.oauthCallbackUrl) !== undefined ||
    readImportedString(value.oauth_callback_url) !== undefined ||
    readImportedOauthConfig(value.auth).callbackUrl !== undefined ||
    readImportedOauthConfig(value.oauth).callbackUrl !== undefined
  );
}

function stripTomlComment(line: string): string {
  let currentQuote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      currentQuote = currentQuote === character ? null : (currentQuote ?? character);
      continue;
    }
    if (character === "#" && currentQuote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlString(value: string): string {
  if (value.startsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value.slice(1, -1);
}

function splitTomlArrayItems(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let currentQuote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      currentQuote = currentQuote === character ? null : (currentQuote ?? character);
      current += character;
      continue;
    }
    if (character === "," && currentQuote === null) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseTomlString(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitTomlArrayItems(inner).map((entry) => parseTomlValue(entry));
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

function parseCodexTomlServers(text: string): McpProjectServersConfig {
  const parsed: Record<string, Record<string, unknown>> = {};
  let currentSection: { serverName: string; kind: "root" | "env" | "headers" | "oauth" } | null =
    null;
  let topLevelOauthCallbackPort: number | undefined;
  let topLevelOauthCallbackUrl: string | undefined;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = /^\[(.+)\]$/u.exec(line);
    if (sectionMatch) {
      const rawSection = sectionMatch[1]?.trim();
      const serverMatch = rawSection
        ? /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.]+))(?:\.(env|headers|oauth))?$/u.exec(
            rawSection,
          )
        : null;
      currentSection = serverMatch
        ? {
            serverName:
              serverMatch[1]?.trim() || serverMatch[2]?.trim() || serverMatch[3]?.trim() || "",
            kind:
              serverMatch[4] === "env" || serverMatch[4] === "headers" || serverMatch[4] === "oauth"
                ? serverMatch[4]
                : "root",
          }
        : null;
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }

    if (!currentSection) {
      if (key === "mcp_oauth_callback_port") {
        const parsedValue = parseTomlValue(rawValue);
        if (typeof parsedValue === "number") {
          topLevelOauthCallbackPort = parsedValue;
        }
      }
      if (key === "mcp_oauth_callback_url") {
        const parsedValue = parseTomlValue(rawValue);
        if (typeof parsedValue === "string" && parsedValue.trim().length > 0) {
          topLevelOauthCallbackUrl = parsedValue.trim();
        }
      }
      continue;
    }

    const server = (parsed[currentSection.serverName] ??= {});
    if (currentSection.kind === "root") {
      server[key] = parseTomlValue(rawValue);
      continue;
    }

    const nestedKey = currentSection.kind;
    const nested = isRecord(server[nestedKey]) ? server[nestedKey] : {};
    const parsedValue = parseTomlValue(rawValue);
    nested[key] = currentSection.kind === "oauth" ? parsedValue : String(parsedValue ?? "");
    server[nestedKey] = nested;
  }

  return normalizeMcpServersRecord(
    Object.fromEntries(
      Object.entries(parsed)
        .map(([name, value]) => {
          const shouldApplyTopLevelOauthCallback = canUseTopLevelOauthCallback(value);
          const decoded = decodeImportedServer({
            ...value,
            ...(topLevelOauthCallbackPort !== undefined &&
            shouldApplyTopLevelOauthCallback &&
            !hasImportedServerOauthCallbackPort(value)
              ? { oauthCallbackPort: topLevelOauthCallbackPort }
              : {}),
            ...(topLevelOauthCallbackUrl &&
            shouldApplyTopLevelOauthCallback &&
            !hasImportedServerOauthCallbackUrl(value)
              ? { oauthCallbackUrl: topLevelOauthCallbackUrl }
              : {}),
          });
          return decoded ? ([name, decoded] as const) : null;
        })
        .filter(
          (entry): entry is readonly [string, McpProjectServersConfig[string]] => entry !== null,
        ),
    ),
  );
}

function parseJsonServers(text: string): McpProjectServersConfig {
  const parsed = JSON.parse(text) as unknown;
  const root = isRecord(parsed)
    ? isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed.mcp_servers)
        ? parsed.mcp_servers
        : parsed
    : null;
  if (!root) {
    return {};
  }

  return normalizeMcpServersRecord(
    Object.fromEntries(
      Object.entries(root)
        .map(([name, value]) => {
          const decoded = decodeImportedServer(value);
          return decoded ? ([name, decoded] as const) : null;
        })
        .filter(
          (entry): entry is readonly [string, McpProjectServersConfig[string]] => entry !== null,
        ),
    ),
  );
}

export function parseImportedServers(text: string): McpProjectServersConfig {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("{")) {
    return parseJsonServers(trimmed);
  }
  return parseCodexTomlServers(trimmed);
}
