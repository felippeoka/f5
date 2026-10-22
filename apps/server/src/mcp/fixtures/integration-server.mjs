// Stdio MCP fixture for IntegrationProxySession tests. Behaviour is selected by env:
// FIXTURE_TOOLS (JSON array of tool names), FIXTURE_PAGE_SIZE, FIXTURE_REVERSE=1.
import { createInterface } from "node:readline";

let tools = JSON.parse(process.env.FIXTURE_TOOLS ?? '["js","js_reset","extra"]');
const pageSize = Number(process.env.FIXTURE_PAGE_SIZE ?? "1");
const schema = { type: "object", properties: { code: { type: "string" } } };
const listed = () => (process.env.FIXTURE_REVERSE === "1" ? [...tools].reverse() : tools);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const waitingForClient = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "notifications/cancelled") {
    process.stderr.write(`cancelled ${request.params.requestId}\n`);
    return;
  }
  // The client's answer to a server-initiated request.
  if (request.method === undefined && waitingForClient.has(request.id)) {
    const callId = waitingForClient.get(request.id);
    waitingForClient.delete(request.id);
    send({
      id: callId,
      result: { content: [{ type: "text", text: `answered ${request.error?.code}` }] },
    });
    return;
  }
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      send({
        id: request.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
      });
      return;
    case "tools/list": {
      const start = Number(request.params?.cursor ?? "0");
      const page = listed().slice(start, start + pageSize);
      const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
      send({
        id: request.id,
        result: {
          tools: page.map((name) => ({
            name,
            description: `${name} ${Math.random()}`,
            inputSchema: schema,
          })),
          ...(next ? { nextCursor: next } : {}),
        },
      });
      return;
    }
    case "tools/call": {
      const code = request.params?.arguments?.code ?? "";
      if (code === "hang") return;
      if (code === "ask") {
        waitingForClient.set("server-1", request.id);
        send({ id: "server-1", method: "sampling/createMessage", params: {} });
        return;
      }
      if (code === "change") {
        tools = [...tools, "added"];
        send({ method: "notifications/tools/list_changed" });
      }
      const delay = code === "slow" ? 150 : 0;
      setTimeout(
        () =>
          send({ id: request.id, result: { content: [{ type: "text", text: `ran ${code}` }] } }),
        delay,
      );
      return;
    }
    default:
      send({ id: request.id, error: { code: -32601, message: "unknown" } });
  }
});
