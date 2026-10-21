import fs from "node:fs";
import path from "node:path";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      fs.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}

export interface AsyncRotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  /** Chunks waiting behind a slow write; later chunks are dropped and counted. */
  readonly maxPendingBytes?: number;
}

/**
 * The same rotation as {@link RotatingFileSink} with asynchronous I/O, one write at a time, so a
 * slow disk never blocks the event loop. `write` never waits; `flushed` resolves once every
 * accepted chunk has been written or has failed.
 */
export class AsyncRotatingFileSink {
  private currentSize = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private running: Promise<void> | undefined;
  private droppedChunks = 0;
  private failedWrites = 0;

  private constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
    private readonly maxPendingBytes: number,
  ) {}

  static async open(options: AsyncRotatingFileSinkOptions): Promise<AsyncRotatingFileSink> {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }
    const sink = new AsyncRotatingFileSink(
      options.filePath,
      options.maxBytes,
      options.maxFiles,
      options.maxPendingBytes ?? Math.max(options.maxBytes, 4 * 1024 * 1024),
    );
    const dir = path.dirname(options.filePath);
    const baseName = path.basename(options.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    for (const entry of await fs.promises.readdir(dir)) {
      if (!entry.startsWith(`${baseName}.`)) continue;
      const suffix = Number(entry.slice(baseName.length + 1));
      if (!Number.isInteger(suffix) || suffix <= options.maxFiles) continue;
      await fs.promises.rm(path.join(dir, entry), { force: true });
    }
    sink.currentSize = await sink.readCurrentSize();
    return sink;
  }

  get statistics(): { readonly droppedChunks: number; readonly failedWrites: number } {
    return { droppedChunks: this.droppedChunks, failedWrites: this.failedWrites };
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;
    if (this.pendingBytes + buffer.length > this.maxPendingBytes) {
      this.droppedChunks += 1;
      return;
    }
    this.pending.push(buffer);
    this.pendingBytes += buffer.length;
    this.schedule();
  }

  async flushed(): Promise<void> {
    while (this.running) await this.running;
  }

  private schedule(): void {
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.pending.length > 0) this.schedule();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const chunks = this.pending;
      this.pending = [];
      this.pendingBytes = 0;
      let index = 0;
      while (index < chunks.length) {
        // Coalesce only chunks that fit the current file, so rotation stays per chunk.
        let end = index + 1;
        try {
          if (this.currentSize > 0 && this.currentSize + chunks[index]!.length > this.maxBytes) {
            await this.rotate();
          }
          let bytes = chunks[index]!.length;
          while (
            end < chunks.length &&
            this.currentSize + bytes + chunks[end]!.length <= this.maxBytes
          ) {
            bytes += chunks[end]!.length;
            end += 1;
          }
          await fs.promises.appendFile(
            this.filePath,
            end === index + 1 ? chunks[index]! : Buffer.concat(chunks.slice(index, end)),
          );
          this.currentSize += bytes;
          if (this.currentSize > this.maxBytes) await this.rotate();
        } catch {
          this.failedWrites += 1;
          this.currentSize = await this.readCurrentSize();
        }
        index = end;
      }
    }
  }

  private async rotate(): Promise<void> {
    await fs.promises.rm(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await renameIfPresent(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
    }
    await renameIfPresent(this.filePath, `${this.filePath}.1`);
    this.currentSize = 0;
  }

  private async readCurrentSize(): Promise<number> {
    try {
      return (await fs.promises.stat(this.filePath)).size;
    } catch {
      return 0;
    }
  }
}

async function renameIfPresent(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
