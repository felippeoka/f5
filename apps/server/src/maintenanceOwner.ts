import { Worker } from "node:worker_threads";
import { Socket } from "node:net";

/**
 * SQLite maintenance can block the helper's main JS thread. Watch the private
 * lifetime pipe on an independent thread so parent death still kills the whole
 * helper (and releases SQLite locks), even in the middle of synchronous VACUUM.
 * This script uses built-ins only and is identical in source and bundled builds.
 */
export async function watchMaintenanceOwner(fd = 3): Promise<() => Promise<void>> {
  // Opening a paused socket sets O_NONBLOCK on Node's inherited POSIX pipe.
  // Without this, readSync can block forever and prevent Worker.terminate().
  // The main thread never reads it; the independent watchdog owns all reads.
  const owner =
    process.platform === "win32" ? null : new Socket({ fd, readable: true, writable: false });
  owner?.pause();
  owner?.unref();
  const watchdog = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { Socket } = require("node:net");
    const { readSync } = require("node:fs");
    const terminate = () => process.kill(process.pid, "SIGKILL");
    try {
      // POSIX pipes are nonblocking. Reading them directly also avoids Bun's
      // network dispatch depending on the main thread during synchronous SQL.
      if (process.platform !== "win32") {
        const byte = Buffer.alloc(1);
        const delay = new Int32Array(new SharedArrayBuffer(4));
        parentPort.postMessage("ready");
        for (;;) {
          try {
            if (readSync(workerData, byte, 0, 1, null) === 0) terminate();
          } catch (error) {
            if (!["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code)) terminate();
          }
          Atomics.wait(delay, 0, 0, 25);
        }
      }
      const owner = new Socket({ fd: workerData, readable: true, writable: false });
      owner.on("end", terminate);
      owner.on("error", terminate);
      owner.resume();
      parentPort.postMessage("ready");
    } catch { terminate(); }
  `,
    { eval: true, workerData: fd, execArgv: [] },
  );
  await new Promise<void>((resolve, reject) => {
    watchdog.once("message", () => resolve());
    watchdog.once("error", reject);
    watchdog.once("exit", (code) =>
      reject(new Error(`Maintenance owner watchdog exited (${code}).`)),
    );
  });
  return async () => {
    await watchdog.terminate();
    owner?.destroy();
  };
}
