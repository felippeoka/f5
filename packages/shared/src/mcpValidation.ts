import { McpProjectServersConfig, type McpProjectConfigResult } from "@t3tools/contracts";
import { Schema } from "effect";

// Keep the existing normalization behavior until the configuration-correctness phase.
export const MAX_SERVER_COUNT = 16;
export const MAX_SERVER_NAME_LENGTH = 128;

export function trimToUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeServerName(name: string): string | undefined {
  const normalized = trimToUndefined(name);
  if (!normalized || normalized.length > MAX_SERVER_NAME_LENGTH) {
    return undefined;
  }
  return normalized;
}

export function normalizeMcpServersRecord(
  value:
    | Record<string, McpProjectServersConfig[string]>
    | McpProjectConfigResult["servers"]
    | null
    | undefined,
): McpProjectServersConfig {
  if (!value) {
    return {};
  }

  const normalized: Record<string, McpProjectServersConfig[string]> = {};
  let count = 0;

  for (const [name, server] of Object.entries(value)) {
    // TODO(Phase 1a): reject overflow at write boundaries and remove this silent
    // truncation from pure normalization. Keep it only for Phase 0 behavior preservation.
    if (count >= MAX_SERVER_COUNT) {
      break;
    }
    const normalizedName = normalizeServerName(name);
    if (!normalizedName) {
      continue;
    }
    normalized[normalizedName] = server;
    count += 1;
  }

  return Schema.decodeUnknownSync(McpProjectServersConfig)(normalized);
}
