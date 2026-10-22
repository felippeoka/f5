import { EventEmitter } from "node:events";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { installAgentDownloadHandler } from "./agentDownloads";

function download(filename: string) {
  const item = {
    savePath: null as string | null,
    getFilename: () => filename,
    getStartTime: () => 1_700_000_000.25,
    setSavePath: (savePath: string) => {
      item.savePath = savePath;
    },
  };
  return item;
}

describe("installAgentDownloadHandler", () => {
  it("saves agent-driven downloads without a dialog and leaves the user's alone", () => {
    const session = new EventEmitter();
    const directory = path.join("/state", "preview-downloads");
    installAgentDownloadHandler(session, {
      directoryFor: () => directory,
      isAgentDriven: (id) => id === 7,
      ensureDirectory: () => undefined,
    });
    // A second install on the same session must not add a second listener.
    installAgentDownloadHandler(session, {
      directoryFor: () => directory,
      isAgentDriven: () => true,
    });
    expect(session.listenerCount("will-download")).toBe(1);

    const agentExport = download("../report.csv");
    const sameName = download("../report.csv");
    session.emit("will-download", {}, agentExport, { id: 7 });
    session.emit("will-download", {}, sameName, { id: 7 });
    expect(path.dirname(agentExport.savePath!)).toBe(directory);
    expect(path.basename(agentExport.savePath!)).toMatch(/^browser-download-.+-report\.csv$/);
    expect(sameName.savePath).not.toBe(agentExport.savePath);

    // No save path means Electron shows its Save dialog, as for any user download.
    const userDownload = download("photo.png");
    session.emit("will-download", {}, userDownload, { id: 8 });
    expect(userDownload.savePath).toBeNull();
  });

  it("saves each profile's downloads in that profile's folder", () => {
    const session = new EventEmitter();
    const folders: Record<number, string> = {
      1: path.join("/state", "preview-downloads"),
      2: path.join("/state", "profiles", "work", "preview-downloads"),
    };
    installAgentDownloadHandler(session, {
      directoryFor: (id) => folders[id],
      isAgentDriven: () => true,
      ensureDirectory: () => undefined,
    });
    const personal = download("a.csv");
    const work = download("b.csv");
    const orphan = download("c.csv");
    session.emit("will-download", {}, personal, { id: 1 });
    session.emit("will-download", {}, work, { id: 2 });
    session.emit("will-download", {}, orphan, { id: 3 });
    expect(path.dirname(personal.savePath!)).toBe(folders[1]);
    expect(path.dirname(work.savePath!)).toBe(folders[2]);
    // An unknown owner keeps the Save dialog instead of borrowing another profile's folder.
    expect(orphan.savePath).toBeNull();
  });
});
