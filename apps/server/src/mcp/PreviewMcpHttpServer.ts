import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import {
  ComputerAutomationBroker,
  type ComputerAutomationBrokerRuntime,
} from "../computer/ComputerAutomationBroker";
import {
  callComputerTool,
  COMPUTER_TOOL_DEFINITIONS,
  COMPUTER_TOOL_TIMEOUT_MS,
  ComputerToolGeometry,
  computerToolInputJsonSchema,
} from "../computer/computerMcpTools";
import { Option } from "effect";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";

import {
  type McpServerDefinition,
  PreviewAutomationExecutionError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Layer, ServiceMap } from "effect";

import {
  PreviewAutomationBroker,
  type PreviewAutomationBrokerShape,
} from "./PreviewAutomationBroker.ts";
import {
  asObject,
  isAllowedHostHeader,
  isLoopbackAddress,
  jsonRpcError,
  jsonRpcSuccess,
  readBearerToken,
  readRequestBody,
  writeEmpty,
  writeJson,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonRpcHttp.ts";
import {
  callPreviewTool,
  chooseServerName,
  PREVIEW_TOOL_DEFINITIONS,
  PREVIEW_TOOL_TIMEOUT_MS,
  previewToolErrorResult,
  previewToolInputJsonSchema,
  type McpToolResult,
} from "./previewMcpTools.ts";

const MCP_ENDPOINT_PATH = "/mcp/preview";
const PREVIEW_MCP_SERVER_NAME = "__f5_preview";
const PREVIEW_MCP_ENV_PREFIX = "F5_PREVIEW_MCP_TOKEN_";
const MCP_PROTOCOL_VERSION = "2024-11-05";

interface PreviewMcpSessionScope {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly automationSessionId: string;
  readonly issuedAt: string;
  readonly catalog: "preview" | "computer";
  geometry: ComputerToolGeometry;
  rpcIncarnation?: string;
}

export interface PreviewMcpSessionConfig {
  readonly serverName: string;
  readonly serverDefinition: McpServerDefinition;
  readonly env: Record<string, string>;
  readonly dispose: () => void;
  readonly endTurn?: (turnId: string) => void;
}

export interface PreviewMcpHttpServerShape {
  readonly getUrl: (catalog?: "preview" | "computer") => string;
  readonly createSessionConfig: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly existingServerNames?: ReadonlySet<string>;
    readonly catalog?: "preview" | "computer";
  }) => PreviewMcpSessionConfig;
}

export class PreviewMcpHttpServer extends ServiceMap.Service<
  PreviewMcpHttpServer,
  PreviewMcpHttpServerShape
>()("t3/mcp/PreviewMcpHttpServer") {}

export class PreviewMcpHttpServerError extends Data.TaggedError("PreviewMcpHttpServerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PREVIEW_MCP_TOOL_LIST = PREVIEW_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: previewToolInputJsonSchema(tool),
  annotations: { ...tool.annotations, title: tool.title },
}));

function makeToolCallHandler(
  broker: PreviewAutomationBrokerShape,
  resolveScope: (token: string) => PreviewMcpSessionScope | undefined,
  computer?: ComputerAutomationBrokerRuntime,
) {
  return async (
    token: string,
    name: string,
    rawArguments: unknown,
    invocationId?: string,
  ): Promise<McpToolResult> => {
    const scope = resolveScope(token);
    if (!scope) {
      return previewToolErrorResult(
        new PreviewAutomationExecutionError({ message: "MCP credential is no longer valid." }),
      );
    }
    if (scope.catalog === "computer") {
      if (!computer) return previewToolErrorResult(new Error("Computer host unavailable."));
      return callComputerTool(
        {
          broker: computer,
          threadId: scope.threadId,
          sessionGeneration: scope.automationSessionId,
          geometry: scope.geometry,
          ...(invocationId !== undefined ? { invocationId } : {}),
        },
        name,
        rawArguments,
      );
    }
    const policy = await Effect.runPromise(broker.resolvePolicy(scope.threadId));
    return callPreviewTool(
      {
        broker,
        policy,
        threadId: scope.threadId,
        automationSessionId: scope.automationSessionId,
      },
      name,
      rawArguments,
    );
  };
}

function nextToken(): string {
  return randomBytes(32).toString("base64url");
}

function nextEnvVarName(): string {
  return `${PREVIEW_MCP_ENV_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`;
}

function handleRpcRequest(input: {
  readonly request: JsonRpcRequest;
  readonly token: string;
  readonly catalog: "preview" | "computer";
  readonly callTool: (
    token: string,
    name: string,
    rawArguments: unknown,
    invocationId?: string,
  ) => Promise<McpToolResult>;
}): Promise<JsonRpcResponse | null> {
  const { request } = input;
  if (request.id === undefined && request.method?.startsWith("notifications/")) {
    return Promise.resolve(null);
  }
  if (typeof request.method !== "string") {
    return Promise.resolve(jsonRpcError(request.id, -32600, "Invalid JSON-RPC request."));
  }

  switch (request.method) {
    case "initialize":
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: input.catalog === "computer" ? "F5 Computer" : "F5 Preview",
            version: "0.0.0",
          },
        }),
      );
    case "ping":
      return Promise.resolve(jsonRpcSuccess(request.id, {}));
    case "tools/list":
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          tools:
            input.catalog === "computer"
              ? COMPUTER_TOOL_DEFINITIONS.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: computerToolInputJsonSchema(tool),
                  annotations: tool.annotations,
                }))
              : PREVIEW_MCP_TOOL_LIST,
        }),
      );
    case "tools/call": {
      const params = asObject(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      return input
        .callTool(
          input.token,
          name,
          params.arguments,
          request.id === undefined ? undefined : JSON.stringify(request.id),
        )
        .then((result) => jsonRpcSuccess(request.id, result));
    }
    case "resources/list":
      return Promise.resolve(jsonRpcSuccess(request.id, { resources: [] }));
    case "prompts/list":
      return Promise.resolve(jsonRpcSuccess(request.id, { prompts: [] }));
    default:
      return Promise.resolve(
        jsonRpcError(request.id, -32601, `Unknown MCP method: ${request.method}`),
      );
  }
}

export const makePreviewMcpHttpServer = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker;
  const computerOption = yield* Effect.serviceOption(ComputerAutomationBroker);
  const computer = Option.getOrUndefined(computerOption);
  const sessionsByToken = new Map<string, PreviewMcpSessionScope>();
  const tokenByEnvVar = new Map<string, string>();
  const callTool = makeToolCallHandler(broker, (token) => sessionsByToken.get(token), computer);
  let expectedHostPort: number | null = null;

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        writeJson(response, 403, { error: "forbidden" });
        return;
      }
      if (!isAllowedHostHeader(request.headers.host, expectedHostPort)) {
        writeJson(response, 403, { error: "invalid_host" });
        return;
      }
      const catalog = request.url === "/mcp/computer" ? "computer" : "preview";
      if (request.url !== MCP_ENDPOINT_PATH && request.url !== "/mcp/computer") {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const token = readBearerToken(request);
      if (!token || sessionsByToken.get(token)?.catalog !== catalog) {
        response.setHeader("www-authenticate", "Bearer");
        writeJson(response, 401, { error: "invalid_mcp_credential" });
        return;
      }

      let body: unknown;
      try {
        body = await readRequestBody(request);
      } catch (cause) {
        writeJson(response, 400, {
          error: "invalid_json",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }

      const scope = sessionsByToken.get(token);
      if (!scope) {
        writeJson(response, 401, { error: "invalid_mcp_credential" });
        return;
      }
      const requests = Array.isArray(body) ? body : [body];
      if (catalog === "computer") {
        const initializes = requests.some((entry) => asObject(entry).method === "initialize");
        if (initializes) {
          scope.rpcIncarnation = randomUUID();
          scope.geometry = new ComputerToolGeometry();
          response.setHeader("Mcp-Session-Id", scope.rpcIncarnation);
        } else if (
          scope.rpcIncarnation &&
          request.headers["mcp-session-id"] !== scope.rpcIncarnation
        ) {
          writeJson(response, 404, { error: "expired_mcp_session" });
          return;
        }
      }
      const results = (
        await Promise.all(
          requests.map((entry) =>
            handleRpcRequest({
              request: asObject(entry) as JsonRpcRequest,
              token,
              catalog,
              callTool: (token, name, args, id) =>
                callTool(
                  token,
                  name,
                  args,
                  id === undefined
                    ? undefined
                    : `${scope.rpcIncarnation ?? scope.automationSessionId}:${id}`,
                ),
            }),
          ),
        )
      ).filter((entry): entry is JsonRpcResponse => entry !== null);

      if (Array.isArray(body)) {
        if (results.length === 0) {
          writeEmpty(response, 202);
          return;
        }
        writeJson(response, 200, results);
        return;
      }
      const result = results[0];
      if (!result) {
        writeEmpty(response, 202);
        return;
      }
      writeJson(response, 200, result);
    })().catch((cause) => {
      writeJson(response, 500, {
        error: "internal_error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });
  });

  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
    catch: (cause) =>
      new PreviewMcpHttpServerError({
        message: cause instanceof Error ? cause.message : "Failed to start preview MCP server.",
        cause,
      }),
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port;
  if (!port) {
    return yield* Effect.die("Preview MCP server did not expose a port.");
  }
  expectedHostPort = port;
  const url = `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`;

  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );

  return {
    getUrl: (catalog = "preview") =>
      catalog === "computer" ? `http://127.0.0.1:${port}/mcp/computer` : url,
    createSessionConfig: (input) => {
      const catalog = input.catalog ?? "preview";
      if (catalog === "computer" && !computer) throw new Error("Computer host unavailable.");
      const token = nextToken();
      const envVarName =
        catalog === "computer"
          ? `F5_COMPUTER_MCP_TOKEN_${randomUUID().replaceAll("-", "_").toUpperCase()}`
          : nextEnvVarName();
      const serverName = chooseServerName(
        catalog === "computer" ? "__f5_computer" : PREVIEW_MCP_SERVER_NAME,
        input.existingServerNames,
      );
      const generation = `codex:${randomUUID()}`;
      const releaseProvenance =
        catalog === "computer" ? automationEventSanitizer.retain(input.threadId) : undefined;
      if (catalog === "computer") computer!.bindSession(input.threadId, generation, "codex");
      const geometry = new ComputerToolGeometry();
      const offComputer =
        catalog === "computer"
          ? computer?.subscribe((event) => {
              if (
                event.channel === "computer.access.grantsChanged" &&
                event.data.threadId === input.threadId
              )
                sessionsByToken.get(token)?.geometry.clear();
              if (
                event.channel === "computer.host" &&
                event.data.type === "pauseChanged" &&
                event.data.threadId === input.threadId
              )
                sessionsByToken.get(token)?.geometry.clear();
            })
          : undefined;
      sessionsByToken.set(token, {
        threadId: input.threadId,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        automationSessionId: generation,
        catalog,
        geometry,
        issuedAt: new Date().toISOString(),
      });
      tokenByEnvVar.set(envVarName, token);

      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        offComputer?.();
        if (catalog === "computer") computer?.releaseSession(input.threadId, generation);
        releaseProvenance?.();
        const storedToken = tokenByEnvVar.get(envVarName);
        tokenByEnvVar.delete(envVarName);
        if (storedToken) {
          sessionsByToken.delete(storedToken);
        }
      };

      return {
        serverName,
        serverDefinition: {
          type: "http",
          url: catalog === "computer" ? `http://127.0.0.1:${port}/mcp/computer` : url,
          enabled: true,
          bearerTokenEnvVar: envVarName,
          supportsParallelToolCalls: false,
          startupTimeoutSec: 10,
          // Explicit, above the longest broker deadline (60 s executor + 2 s grace).
          toolTimeoutSec:
            (catalog === "computer" ? COMPUTER_TOOL_TIMEOUT_MS : PREVIEW_TOOL_TIMEOUT_MS) / 1000,
        },
        env: {
          [envVarName]: token,
        },
        dispose,
        ...(catalog === "computer"
          ? { endTurn: (turnId: string) => computer?.endTurn(input.threadId, turnId, generation) }
          : {}),
      };
    },
  } satisfies PreviewMcpHttpServerShape;
});

export const PreviewMcpHttpServerLive = Layer.effect(
  PreviewMcpHttpServer,
  makePreviewMcpHttpServer,
);
