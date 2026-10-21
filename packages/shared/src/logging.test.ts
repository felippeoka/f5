import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AsyncRotatingFileSink } from "./logging";

const directories: string[] = [];
const tempFile = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-async-sink-"));
  directories.push(directory);
  return path.join(directory, "events.log");
};
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

describe("AsyncRotatingFileSink", () => {
  it("returns while the disk write is still blocked and writes every accepted chunk", async () => {
    const filePath = tempFile();
    const sink = await AsyncRotatingFileSink.open({ filePath, maxBytes: 1024, maxFiles: 2 });
    const append = fs.promises.appendFile;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(fs.promises, "appendFile")
      .mockImplementation((...args) => gate.then(() => append(...args)));
    try {
      sink.write("first\n");
      sink.write("second\n");
      expect(spy).toHaveBeenCalledOnce();
      expect(fs.existsSync(filePath)).toBe(false);
      release();
      await sink.flushed();
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(filePath, "utf8")).toBe("first\nsecond\n");
  });

  it("rotates per chunk and keeps at most maxFiles backups", async () => {
    const filePath = tempFile();
    fs.writeFileSync(`${filePath}.5`, "stale");
    const sink = await AsyncRotatingFileSink.open({ filePath, maxBytes: 10, maxFiles: 2 });
    expect(fs.existsSync(`${filePath}.5`)).toBe(false);
    for (const chunk of ["aaaa\n", "bbbb\n", "cccc\n", "dddd\n", "eeee\n"]) sink.write(chunk);
    await sink.flushed();
    expect(fs.readFileSync(`${filePath}.2`, "utf8")).toBe("aaaa\nbbbb\n");
    expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("cccc\ndddd\n");
    expect(fs.readFileSync(filePath, "utf8")).toBe("eeee\n");
    expect(fs.existsSync(`${filePath}.3`)).toBe(false);
  });

  it("drops and counts chunks beyond the pending bound while a write is in flight", async () => {
    const filePath = tempFile();
    const sink = await AsyncRotatingFileSink.open({
      filePath,
      maxBytes: 1024,
      maxFiles: 1,
      maxPendingBytes: 4,
    });
    sink.write("aaaa");
    sink.write("bbbb");
    sink.write("cccc");
    await sink.flushed();
    expect(fs.readFileSync(filePath, "utf8")).toBe("aaaabbbb");
    expect(sink.statistics).toEqual({ droppedChunks: 1, failedWrites: 0 });
  });

  it("counts a failed write and keeps writing once the destination returns", async () => {
    const filePath = tempFile();
    const sink = await AsyncRotatingFileSink.open({ filePath, maxBytes: 1024, maxFiles: 1 });
    fs.rmSync(path.dirname(filePath), { recursive: true });
    sink.write("lost\n");
    await sink.flushed();
    expect(sink.statistics.failedWrites).toBe(1);
    fs.mkdirSync(path.dirname(filePath));
    sink.write("kept\n");
    await sink.flushed();
    expect(fs.readFileSync(filePath, "utf8")).toBe("kept\n");
  });
});
