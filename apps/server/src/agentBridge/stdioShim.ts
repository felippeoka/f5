/**
 * `t3 agent-bridge-stdio`: forwards each stdin JSON-RPC line to the local
 * Agent Bridge listener as `POST /mcp` and writes each reply to stdout.
 * `local.json` is re-read for every request, so an F5 restart (which rotates
 * the token and port) needs no client reconfiguration.
 *
 * @module agentBridge/stdioShim
 */
import * as Readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import { jsonRpcError, jsonRpcSuccess, type JsonRpcRequest } from "../mcp/jsonRpcHttp.ts";
import { AGENT_PROCESS_ENV } from "../providerProcessEnv.ts";
import { readAgentBridgeLocalCredentials } from "./localCredentials.ts";
import { AGENT_BRIDGE_MCP_PATH } from "./AgentBridgeListeners.ts";
import {
  AGENT_BRIDGE_SERVER_INFO,
  AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS,
  MCP_VERSION_INITIALIZE,
} from "./mcpProtocol.ts";

/** JSON-RPC error for "F5 or the bridge is not reachable". */
export const AGENT_BRIDGE_UNAVAILABLE_CODE = -32002;
const REQUEST_TIMEOUT_MS = 120_000;
const UNAVAILABLE_MESSAGE =
  "F5 Agent Bridge is not running. Open F5 and turn on the Agent Bridge in Settings > Integrations.";
const AGENT_PROCESS_MESSAGE = "F5 Agent Bridge is not available to agents that F5 itself runs.";

export interface AgentBridgeStdioOptions {
  readonly credentialsPath: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
}

/**
 * Replies served without contacting F5 when the shim runs inside one of F5's
 * own agent processes. The ChatGPT desktop app and the Codex CLI share
 * `~/.codex/config.toml`, so F5's Codex agents would otherwise see the bridge.
 */
function recursionGuardReply(request: JsonRpcRequest) {
  switch (request.method) {
    case "initialize":
      return jsonRpcSuccess(request.id, {
        protocolVersion: MCP_VERSION_INITIALIZE,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...AGENT_BRIDGE_SERVER_INFO, version: "0.0.0" },
        instructions: AGENT_PROCESS_MESSAGE,
      });
    case "server/discover":
      return jsonRpcSuccess(request.id, {
        supportedVersions: [...AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...AGENT_BRIDGE_SERVER_INFO, version: "0.0.0" },
        instructions: AGENT_PROCESS_MESSAGE,
      });
    case "ping":
      return jsonRpcSuccess(request.id, {});
    case "tools/list":
      return jsonRpcSuccess(request.id, { tools: [] });
    default:
      return jsonRpcError(request.id, AGENT_BRIDGE_UNAVAILABLE_CODE, AGENT_PROCESS_MESSAGE);
  }
}

export function runAgentBridgeStdio(options: AgentBridgeStdioOptions): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const insideAgent = env[AGENT_PROCESS_ENV] === "1";
  let negotiatedVersion: string | undefined;
  const pending = new Set<Promise<void>>();

  const write = (message: unknown) => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const forward = async (request: JsonRpcRequest, line: string): Promise<void> => {
    const isNotification = request.id === undefined;
    const fail = (message: string) => {
      if (!isNotification) write(jsonRpcError(request.id, AGENT_BRIDGE_UNAVAILABLE_CODE, message));
    };
    if (insideAgent) {
      if (!isNotification) write(recursionGuardReply(request));
      return;
    }
    const credentials = await readAgentBridgeLocalCredentials(options.credentialsPath);
    if (!credentials) return fail(UNAVAILABLE_MESSAGE);
    let response: Response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${credentials.port}${AGENT_BRIDGE_MCP_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(negotiatedVersion && request.method !== "initialize"
            ? { "mcp-protocol-version": negotiatedVersion }
            : {}),
        },
        body: line,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return fail(UNAVAILABLE_MESSAGE);
    }
    if (response.status === 202) return;
    if (response.status === 401) return fail(UNAVAILABLE_MESSAGE);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail(`F5 Agent Bridge returned HTTP ${response.status}.`);
    }
    if (request.method === "initialize" && response.ok) {
      const version = (body as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
      if (typeof version === "string") negotiatedVersion = version;
    }
    if (!isNotification) write(body);
  };

  return new Promise<void>((resolve) => {
    const lines = Readline.createInterface({ input: options.input, crlfDelay: Infinity });
    lines.on("line", (raw) => {
      const line = raw.trim();
      if (line.length === 0) return;
      let request: JsonRpcRequest;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          write(jsonRpcError(null, -32600, "Send one JSON-RPC message per line."));
          return;
        }
        request = parsed as JsonRpcRequest;
      } catch {
        write(jsonRpcError(null, -32700, "Parse error."));
        return;
      }
      // Requests run concurrently: a long wait_for_submission must not block others.
      const task = forward(request, line).catch(() => {
        if (request.id !== undefined)
          write(jsonRpcError(request.id, AGENT_BRIDGE_UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE));
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    lines.on("close", () => {
      void Promise.allSettled(pending).then(() => resolve());
    });
  });
}
