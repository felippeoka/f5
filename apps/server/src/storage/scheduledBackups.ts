import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Schedule } from "effect";
import type { BackupService } from "../backupService.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUCCESSFUL_BACKUP = /^daily-(\d{13})-([a-f0-9-]{36})\.f5backup$/;

export async function listScheduledBackups(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && SUCCESSFUL_BACKUP.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      createdAt: Number(SUCCESSFUL_BACKUP.exec(entry.name)![1]),
    }))
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

/** A failed or interrupted export never publishes a success or prunes older backups. */
export function runScheduledBackup(backup: BackupService, directory: string, now = Date.now()) {
  return Effect.gen(function* () {
    const previous = yield* Effect.tryPromise(() => listScheduledBackups(directory));
    if (previous[0] && now - previous[0].createdAt < DAY_MS) return;
    yield* Effect.tryPromise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
    const name = `daily-${now}-${randomUUID()}.f5backup`;
    const temporary = resolve(directory, `${name}.partial`);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
        // Opening the destination can fail while the helper is still preparing
        // the archive. pipeline() later observes the stream's recorded error.
        output.on("error", () => {});
        return output;
      }),
      (output) =>
        Effect.gen(function* () {
          // Scheduled exports never persist a password or copy credentials.
          yield* backup.exportArchive({ output, includeSecrets: false });
          yield* Effect.tryPromise(() => rename(temporary, resolve(directory, name)));
          const completed = yield* Effect.tryPromise(() => listScheduledBackups(directory));
          for (const stale of completed.slice(7)) {
            yield* Effect.tryPromise(() => rm(resolve(directory, stale.name)));
          }
        }),
      (output) =>
        Effect.promise(async () => {
          output.destroy();
          await rm(temporary, { force: true });
        }),
    );
  });
}

export const startScheduledBackups = (backup: BackupService) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const tick = Effect.gen(function* () {
      if (!(yield* settings.getSettings).scheduledBackupsEnabled) return;
      yield* runScheduledBackup(backup, resolve(config.stateDir, "backups"));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("scheduled backup failed", { cause: String(cause) }),
      ),
    );
    yield* tick.pipe(
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.delay("1 minute"),
      Effect.forkScoped,
    );
  });
