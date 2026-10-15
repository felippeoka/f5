import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { ProjectWatchedPathChange } from "@t3tools/contracts";

/**
 * Ref-counted watches on workspace files and directories that clients have
 * open. Each watched path keeps a stat signature and a revision that advances
 * on every observed change; subscribers get batched change notifications.
 *
 * `fs.watch` events are hints only: every event re-stats the path, so atomic
 * saves (write a temp file, rename it over the target), renames and deletes
 * are reported from what is on disk. When a watch cannot be established or
 * fails, the path is polled instead and subscribers are told they are
 * degraded, so they can keep broader refresh triggers.
 */

export type WorkspaceWatchKind = "file" | "directory";

export interface WorkspaceWatchNotification {
  readonly cwd: string;
  readonly changes: ReadonlyArray<ProjectWatchedPathChange>;
  /** True while any of this subscriber's paths in `cwd` are polled. */
  readonly degraded: boolean;
}

export interface WorkspaceWatchRegistryOptions<S> {
  readonly notify: (subscriber: S, notification: WorkspaceWatchNotification) => void;
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxPathsPerSubscriber?: number;
  /** Test seam; defaults to `fs.watch`. */
  readonly watch?: (target: string, listener: (eventType: string) => void) => fs.FSWatcher;
}

export interface WorkspaceWatchResult {
  readonly watched: number;
  readonly degraded: boolean;
  /** Paths rejected as invalid or outside the workspace. */
  readonly rejected: ReadonlyArray<string>;
}

interface WatchEntry<S> {
  readonly key: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly kind: WorkspaceWatchKind;
  readonly absolutePath: string;
  readonly subscribers: Set<S>;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Polling because watching failed, as opposed to waiting for the path to exist. */
  watchFailed: boolean;
  ready: Promise<void>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  signature: string | null;
  revision: number;
  checking: Promise<void> | null;
  disposed: boolean;
}

const DEFAULT_DEBOUNCE_MS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_PATHS_PER_SUBSCRIBER = 512;

/** Workspace-relative, forward slashes, no `.`/`..`/`.git` segments. */
export function normalizeWatchedRelativePath(relativePath: string): string | null {
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) return null;
  const segments = relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment === ".git")) return null;
  return segments.join("/");
}

async function statSignature(absolutePath: string, kind: WorkspaceWatchKind) {
  try {
    const stat = await fsp.stat(absolutePath);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return null;
    // A directory's mtime moves when entries are added, removed or renamed.
    return kind === "directory"
      ? `${stat.ino}:${stat.mtimeMs}`
      : `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

export class WorkspaceWatchRegistry<S> {
  private readonly entries = new Map<string, WatchEntry<S>>();
  private readonly keysBySubscriber = new Map<S, Map<string, Set<string>>>();
  private readonly pendingBySubscriber = new Map<S, Map<string, ProjectWatchedPathChange[]>>();
  private flushScheduled = false;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPathsPerSubscriber: number;
  private readonly watch: NonNullable<WorkspaceWatchRegistryOptions<S>["watch"]>;

  constructor(private readonly options: WorkspaceWatchRegistryOptions<S>) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPathsPerSubscriber = options.maxPathsPerSubscriber ?? DEFAULT_MAX_PATHS_PER_SUBSCRIBER;
    this.watch = options.watch ?? ((target, listener) => fs.watch(target, listener));
  }

  /**
   * Replaces the subscriber's watched set for `cwd`. Idempotent, so clients
   * resend their full set after a reconnect.
   */
  async setWatchedPaths(
    subscriber: S,
    input: {
      readonly cwd: string;
      readonly files: ReadonlyArray<string>;
      readonly directories: ReadonlyArray<string>;
    },
  ): Promise<WorkspaceWatchResult> {
    const root = await fsp.realpath(input.cwd);
    const rejected: string[] = [];
    const nextKeys = new Set<string>();
    const requests: Array<{ relativePath: string; kind: WorkspaceWatchKind }> = [
      ...input.files.map((relativePath) => ({ relativePath, kind: "file" as const })),
      ...input.directories.map((relativePath) => ({ relativePath, kind: "directory" as const })),
    ];
    const otherCwdCount = [...(this.keysBySubscriber.get(subscriber)?.entries() ?? [])]
      .filter(([cwd]) => cwd !== input.cwd)
      .reduce((sum, [, keys]) => sum + keys.size, 0);

    for (const request of requests) {
      const relativePath = normalizeWatchedRelativePath(request.relativePath);
      if (relativePath === null || otherCwdCount + nextKeys.size >= this.maxPathsPerSubscriber) {
        rejected.push(request.relativePath);
        continue;
      }
      const absolutePath = relativePath ? path.join(root, relativePath) : root;
      if (!(await this.isInsideWorkspace(root, absolutePath))) {
        rejected.push(request.relativePath);
        continue;
      }
      const key = `${request.kind}\u0000${absolutePath}`;
      nextKeys.add(key);
      let entry = this.entries.get(key);
      if (!entry) {
        entry = this.createEntry(key, input.cwd, relativePath, request.kind, absolutePath);
        this.entries.set(key, entry);
      }
      await entry.ready;
    }

    const byCwd = this.keysBySubscriber.get(subscriber) ?? new Map<string, Set<string>>();
    const previousKeys = byCwd.get(input.cwd) ?? new Set<string>();
    for (const key of nextKeys) this.entries.get(key)?.subscribers.add(subscriber);
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) this.releaseKey(subscriber, key);
    }
    if (nextKeys.size > 0) {
      byCwd.set(input.cwd, nextKeys);
      this.keysBySubscriber.set(subscriber, byCwd);
    } else {
      byCwd.delete(input.cwd);
      if (byCwd.size === 0) this.keysBySubscriber.delete(subscriber);
    }

    return {
      watched: nextKeys.size,
      degraded: this.isDegraded(nextKeys),
      rejected,
    };
  }

  /** Drops every watch held by a subscriber (for example on disconnect). */
  releaseSubscriber(subscriber: S): void {
    const byCwd = this.keysBySubscriber.get(subscriber);
    this.keysBySubscriber.delete(subscriber);
    this.pendingBySubscriber.delete(subscriber);
    if (!byCwd) return;
    for (const keys of byCwd.values()) {
      for (const key of keys) this.releaseKey(subscriber, key);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.entries.clear();
    this.keysBySubscriber.clear();
    this.pendingBySubscriber.clear();
  }

  /** Number of distinct watched paths across subscribers (for tests and metrics). */
  get size(): number {
    return this.entries.size;
  }

  private async isInsideWorkspace(root: string, absolutePath: string): Promise<boolean> {
    let resolved = absolutePath;
    try {
      resolved = await fsp.realpath(absolutePath);
    } catch {
      // Not created yet: the lexical path was already validated.
      return true;
    }
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private isDegraded(keys: Iterable<string>): boolean {
    for (const key of keys) {
      if (this.entries.get(key)?.watchFailed) return true;
    }
    return false;
  }

  private createEntry(
    key: string,
    cwd: string,
    relativePath: string,
    kind: WorkspaceWatchKind,
    absolutePath: string,
  ): WatchEntry<S> {
    const entry: WatchEntry<S> = {
      key,
      cwd,
      relativePath,
      kind,
      absolutePath,
      subscribers: new Set(),
      watcher: null,
      pollTimer: null,
      watchFailed: false,
      ready: Promise.resolve(),
      debounceTimer: null,
      signature: null,
      revision: 0,
      checking: null,
      disposed: false,
    };
    entry.ready = statSignature(absolutePath, kind).then((signature) => {
      entry.signature = signature;
      if (!entry.disposed) this.arm(entry);
    });
    return entry;
  }

  /** Watches the path when it exists, and polls when it does not or watching fails. */
  private arm(entry: WatchEntry<S>): void {
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.signature !== null) {
      try {
        const watcher = this.watch(entry.absolutePath, (eventType) => {
          this.scheduleCheck(entry, eventType === "rename");
        });
        watcher.on("error", () => {
          if (entry.watcher !== watcher) return;
          watcher.close();
          entry.watcher = null;
          this.startPolling(entry, true);
        });
        entry.watcher = watcher;
        this.stopPolling(entry);
        return;
      } catch {
        // Unsupported file system, watch limit reached, or permissions.
        this.startPolling(entry, true);
        return;
      }
    }
    // Missing path: poll until it appears, then watch it.
    this.startPolling(entry, false);
  }

  private startPolling(entry: WatchEntry<S>, watchFailed: boolean): void {
    if (entry.disposed) return;
    if (entry.watchFailed !== watchFailed) {
      entry.watchFailed = watchFailed;
      this.queueStatusChange(entry);
    }
    if (entry.pollTimer) return;
    entry.pollTimer = setInterval(() => this.scheduleCheck(entry, true), this.pollIntervalMs);
    entry.pollTimer.unref?.();
  }

  private stopPolling(entry: WatchEntry<S>): void {
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    entry.pollTimer = null;
    if (entry.watchFailed) {
      entry.watchFailed = false;
      this.queueStatusChange(entry);
    }
  }

  private scheduleCheck(entry: WatchEntry<S>, rearm: boolean): void {
    if (entry.disposed) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.check(entry, rearm);
    }, this.debounceMs);
    entry.debounceTimer.unref?.();
  }

  private async check(entry: WatchEntry<S>, rearm: boolean): Promise<void> {
    // Serialize checks so revisions advance in observation order.
    while (entry.checking) await entry.checking;
    const run = (async () => {
      const previous = entry.signature;
      const next = await statSignature(entry.absolutePath, entry.kind);
      if (entry.disposed) return;
      entry.signature = next;
      const inodeChanged = previous?.split(":")[0] !== next?.split(":")[0];
      // A rename or atomic save replaces the inode the watcher was bound to.
      if (rearm && (inodeChanged || next === null || !entry.watcher)) this.arm(entry);
      else if (!entry.watcher && !entry.pollTimer) this.arm(entry);
      if (previous === next) return;
      entry.revision += 1;
      this.queueChange(entry, {
        relativePath: entry.relativePath,
        kind: entry.kind,
        change: next === null ? "deleted" : previous === null ? "created" : "changed",
        revision: entry.revision,
      });
    })();
    entry.checking = run;
    try {
      await run;
    } finally {
      if (entry.checking === run) entry.checking = null;
    }
  }

  private queueChange(entry: WatchEntry<S>, change: ProjectWatchedPathChange): void {
    for (const subscriber of entry.subscribers) {
      const byCwd = this.pendingBySubscriber.get(subscriber) ?? new Map();
      const changes = byCwd.get(entry.cwd) ?? [];
      changes.push(change);
      byCwd.set(entry.cwd, changes);
      this.pendingBySubscriber.set(subscriber, byCwd);
    }
    this.scheduleFlush();
  }

  /** Watch/poll transitions reach subscribers as an empty change batch. */
  private queueStatusChange(entry: WatchEntry<S>): void {
    for (const subscriber of entry.subscribers) {
      const byCwd = this.pendingBySubscriber.get(subscriber) ?? new Map();
      if (!byCwd.has(entry.cwd)) byCwd.set(entry.cwd, []);
      this.pendingBySubscriber.set(subscriber, byCwd);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const pending = [...this.pendingBySubscriber];
      this.pendingBySubscriber.clear();
      for (const [subscriber, byCwd] of pending) {
        const keysByCwd = this.keysBySubscriber.get(subscriber);
        if (!keysByCwd) continue;
        for (const [cwd, changes] of byCwd) {
          const keys = keysByCwd.get(cwd);
          if (!keys) continue;
          this.options.notify(subscriber, { cwd, changes, degraded: this.isDegraded(keys) });
        }
      }
    });
  }

  private releaseKey(subscriber: S, key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size > 0) return;
    this.closeEntry(entry);
    this.entries.delete(key);
  }

  private closeEntry(entry: WatchEntry<S>): void {
    entry.disposed = true;
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    entry.pollTimer = null;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
}
