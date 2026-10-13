import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { closeRehearsalChild } from "./rehearsalCleanup";
describe("owned rehearsal cleanup", () => {
  it("requires an actual child exit, not merely a sent signal", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise<void>((done) => child.once("spawn", () => done()));
    expect(await closeRehearsalChild(child)).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("returns false on an unresponsive child and leaves further decisions to its owner", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((done) => child.stdout!.once("data", () => done()));
    try {
      expect(await closeRehearsalChild(child, 20)).toBe(process.platform === "win32");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((done) => child.once("exit", () => done()));
      }
    }
  });
});
