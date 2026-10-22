import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { CodexControlClient } from "./CodexControlClient.ts";
import { ProviderLineReader } from "./lineReader.ts";
import { createJsonRpcStdinWriter } from "./JsonRpcStdinWriter.ts";

it("reports malformed control lines without losing the session and removes source listeners on exit", () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: true,
    exitCode: null,
    signalCode: null,
  });
  const output = new ProviderLineReader(child.stdout);
  const writer = createJsonRpcStdinWriter({ stdin: child.stdin, closedMessage: "closed" });
  const client = Reflect.construct(CodexControlClient, [
    { cwd: process.cwd() },
    child,
    output,
    writer,
    { configRead: true, listMcpServerStatus: true },
  ]) as CodexControlClient;
  const malformed = vi.fn();
  const notification = vi.fn();
  const closed = vi.fn();
  client.on("protocolError", malformed);
  client.on("notification", notification);
  client.on("closed", closed);
  child.stdout.write('{invalid\n{"method":"supported/notification","params":{}}\n');
  expect(malformed).toHaveBeenCalledTimes(1);
  expect(notification).toHaveBeenCalledTimes(1);
  expect(closed).not.toHaveBeenCalled();
  child.emit("exit", 1, null);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(child.listenerCount("error")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(output.listenerCount("line")).toBe(0);
  expect(child.stdout.listenerCount("data")).toBe(0);
  client.close();
  expect(closed).toHaveBeenCalledTimes(1);
});
