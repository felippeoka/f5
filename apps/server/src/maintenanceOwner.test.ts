import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";

test("Node can stop the watchdog while the owning backend keeps its lifetime pipe open", async () => {
  const entry = new URL("./maintenanceOwner.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { watchMaintenanceOwner } = await import(${JSON.stringify(entry)}); const stop = await watchMaintenanceOwner(); await stop(); process.stdout.write("stopped");`,
    ],
    { stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  let output = "",
    error = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    error += String(chunk);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code] = await Promise.race([
      once(child, "close"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Watchdog did not stop: ${error}`)), 2000);
      }),
    ]);
    expect(code, error).toBe(0);
    expect(output).toBe("stopped");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
  }
});
