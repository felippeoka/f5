import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export async function connectStoreClient(url: string) {
  const child = spawn(
    "bun",
    [fileURLToPath(new URL("../../../web/src/test/chaosClient.ts", import.meta.url)), url],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  const messages: Array<Record<string, unknown>> = [];
  let failure: Error | undefined;
  const waiters = new Set<{
    type: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "failure") {
      failure = new Error(String(value.message));
      for (const waiter of waiters) waiter.reject(new Error(String(value.message)));
      waiters.clear();
      return;
    }
    const waiter = [...waiters].find((waiter) => waiter.type === value.type);
    if (waiter) {
      waiters.delete(waiter);
      waiter.resolve(value);
    } else messages.push(value);
  });
  const exited = once(child, "exit");
  child.once("exit", () => {
    for (const waiter of waiters) waiter.reject(new Error(`Chaos client exited: ${stderr}`));
    waiters.clear();
  });
  const next = async (type: string): Promise<Record<string, unknown>> => {
    if (failure) throw failure;
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return messages.splice(index, 1)[0]!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: {
      type: string;
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    };
    try {
      return await new Promise((resolve, reject) => {
        waiter = { type, resolve, reject };
        waiters.add(waiter);
        timer = setTimeout(
          () => reject(new Error(`Waiting for client ${type}: ${stderr}`)),
          10_000,
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      waiters.delete(waiter!);
    }
  };
  const send = (method: string) => child.stdin.write(`${JSON.stringify({ method })}\n`);
  const close = async () => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_800);
    try {
      if (child.exitCode === null && child.signalCode === null) send("quit");
      await exited;
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.stderr.destroy();
    }
  };
  return { next, send, close };
}
