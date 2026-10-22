import * as fs from "node:fs";
import * as path from "node:path";

interface DownloadItemLike {
  getFilename(): string;
  getStartTime(): number;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(path: string): void;
  cancel(): void;
  on(event: "updated", listener: () => void): unknown;
}

/** A page the agent visits cannot fill the disk: each download is capped, and so is the folder. */
export const AGENT_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
export const AGENT_DOWNLOADS_KEPT = 50;

/** Removes the oldest saved downloads so at most `keep` remain, best effort. */
export function pruneAgentDownloads(directory: string, keep = AGENT_DOWNLOADS_KEPT): void {
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.startsWith("browser-download-"));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const files = names.flatMap((name) => {
    try {
      return [{ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }];
    } catch {
      return [];
    }
  });
  files.sort((left, right) => left.mtime - right.mtime);
  for (const file of files.slice(0, Math.max(0, files.length - keep)))
    fs.rmSync(path.join(directory, file.name), { force: true });
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
 * is driving is saved to the directory of the profile that owns the page instead; one the
 * user starts, or one whose owning profile is unknown, keeps the Save dialog.
 * Installed once per session.
 */
export function installAgentDownloadHandler(
  session: DownloadSessionLike,
  options: {
    /** The owning profile's download folder for a source page, or undefined when unknown. */
    readonly directoryFor: (sourceWebContentsId: number) => string | undefined;
    readonly isAgentDriven: (sourceWebContentsId: number) => boolean;
    readonly ensureDirectory?: (directory: string) => void;
    /** Runs before each saved download, so the folder keeps its newest files only. */
    readonly prune?: (directory: string) => void;
  },
): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  session.on("will-download", (_event, item, source) => {
    if (!options.isAgentDriven(source.id)) return;
    const directory = options.directoryFor(source.id);
    if (directory === undefined) return;
    // Without a save path Electron would show its Save dialog, so an oversized download is
    // cancelled instead of falling back to one.
    if (item.getTotalBytes() > AGENT_DOWNLOAD_MAX_BYTES) {
      item.cancel();
      return;
    }
    // A server may not send the size, so the received bytes are checked as they arrive.
    item.on("updated", () => {
      if (item.getReceivedBytes() > AGENT_DOWNLOAD_MAX_BYTES) item.cancel();
    });
    (options.ensureDirectory ?? ((target) => fs.mkdirSync(target, { recursive: true })))(directory);
    (options.prune ?? pruneAgentDownloads)(directory);
    // The start time keeps names unique across restarts; the count keeps two same-name
    // downloads in one millisecond from overwriting each other.
    const id = `${Math.round(item.getStartTime() * 1000).toString(36)}-${(downloadCount++).toString(36)}`;
    item.setSavePath(
      path.join(directory, `browser-download-${id}-${path.basename(item.getFilename())}`),
    );
  });
}
