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
      directory,
      isAgentDriven: (id) => id === 7,
      ensureDirectory: () => undefined,
    });
    // A second install on the same session must not add a second listener.
    installAgentDownloadHandler(session, { directory, isAgentDriven: () => true });
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
});
