import * as fs from "node:fs";
import * as path from "node:path";

interface DownloadItemLike {
  getFilename(): string;
  getStartTime(): number;
  setSavePath(path: string): void;
}

interface DownloadSessionLike {
  on(
    event: "will-download",
    listener: (event: unknown, item: DownloadItemLike, source: { readonly id: number }) => void,
  ): unknown;
}

const installedSessions = new WeakSet<object>();
let downloadCount = 0;

/**
 * Electron opens a native Save dialog for a download with no save path, so every export an agent
 * clicked while testing a page put a modal over the whole app. A download from a page the agent
 * is driving is saved to `directory` instead; one the user starts keeps the Save dialog.
 * Installed once per session.
 */
export function installAgentDownloadHandler(
  session: DownloadSessionLike,
  options: {
    readonly directory: string;
    readonly isAgentDriven: (sourceWebContentsId: number) => boolean;
    readonly ensureDirectory?: (directory: string) => void;
  },
): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  session.on("will-download", (_event, item, source) => {
    if (!options.isAgentDriven(source.id)) return;
    (options.ensureDirectory ?? ((directory) => fs.mkdirSync(directory, { recursive: true })))(
      options.directory,
    );
    // The start time keeps names unique across restarts; the count keeps two same-name
    // downloads in one millisecond from overwriting each other.
    const id = `${Math.round(item.getStartTime() * 1000).toString(36)}-${(downloadCount++).toString(36)}`;
    item.setSavePath(
      path.join(options.directory, `browser-download-${id}-${path.basename(item.getFilename())}`),
    );
  });
}
