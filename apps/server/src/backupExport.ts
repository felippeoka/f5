import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { version as appVersion } from "../package.json" with { type: "json" };
import { openRuntimeSqliteDatabase } from "./persistence/runtimeSqlite.ts";
import { validateBackupDatabase } from "./backupDatabase.ts";
import { exists, isInside, listRegularFiles, archivePathForFile } from "./backupFiles.ts";
import {
  backupTemporaryStorageBudget,
  resolveBackupRestoreLimits,
  writeBackupArchive,
  type BackupArchiveEntry,
  type BackupManifest,
} from "./backupArchive.ts";
import type { BackupExportConfig } from "./backupMaintenance.ts";

/** Runs only in the maintenance child; never uses the application's SQL connection. */
export async function buildBackupArchive(input: {
  config: BackupExportConfig;
  stagingDir: string;
  includeSecrets: boolean;
  password?: string;
}): Promise<BackupManifest> {
  const { config, stagingDir, includeSecrets, password } = input;
  const restoreLimits = resolveBackupRestoreLimits();
  const databaseSnapshot = resolve(stagingDir, "database.sqlite");
  if (!(await lstat(config.dbPath)).isFile())
    throw new Error("Backup source database is not a regular file.");
  // A WAL reader may need to create sidecars when the application connection
  // has just closed. Only snapshot reads run on this dedicated handle.
  const database = await openRuntimeSqliteDatabase(config.dbPath, { readOnly: false });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`VACUUM INTO '${databaseSnapshot.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  await validateBackupDatabase(databaseSnapshot);
  const archivePath = resolve(stagingDir, "backup.f5backup");
  const snapshotBytes = (await stat(databaseSnapshot)).size;
  const availableTemporaryBytes = await backupTemporaryStorageBudget(stagingDir, restoreLimits);
  const maxArchiveBytes = Math.min(
    restoreLimits.maxCompressedBytes,
    availableTemporaryBytes,
    Math.max(0, restoreLimits.maxTemporaryBytes - snapshotBytes),
  );
  if (maxArchiveBytes <= 0) {
    throw new Error("Not enough free disk space to create a backup safely.");
  }
  const entries: BackupArchiveEntry[] = [
    { archivePath: "database.sqlite", sourcePath: databaseSnapshot, encrypt: false },
  ];
  if (config.settingsPath && (await exists(config.settingsPath))) {
    const settingsSnapshot = resolve(stagingDir, "settings.json");
    await copyFile(config.settingsPath, settingsSnapshot);
    entries.push({
      archivePath: "settings.json",
      sourcePath: settingsSnapshot,
      encrypt: false,
    });
  }
  if (await exists(config.keybindingsConfigPath)) {
    const keybindingsSnapshot = resolve(stagingDir, "keybindings.json");
    await copyFile(config.keybindingsConfigPath, keybindingsSnapshot);
    entries.push({
      archivePath: "keybindings.json",
      sourcePath: keybindingsSnapshot,
      encrypt: false,
    });
  }
  const snapshot = await openRuntimeSqliteDatabase(databaseSnapshot, { readOnly: true });
  let attachmentFiles: string[];
  try {
    const hasRegistry = snapshot
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_owners'")
      .get();
    attachmentFiles = hasRegistry
      ? (
          snapshot
            .prepare(
              "SELECT final_path FROM attachments WHERE lifecycle = 'ready' AND EXISTS (SELECT 1 FROM attachment_owners WHERE attachment_owners.attachment_id = attachments.attachment_id)",
            )
            .all() as { final_path: string }[]
        ).map((row) => row.final_path)
      : await listRegularFiles(config.attachmentsDir);
  } finally {
    snapshot.close();
  }
  for (const file of attachmentFiles) {
    if (!isInside(config.attachmentsDir, file) || !(await lstat(file)).isFile()) {
      throw new Error("Snapshot attachment is outside storage or is not a regular file.");
    }
    entries.push({
      archivePath: archivePathForFile("attachments", config.attachmentsDir, file),
      sourcePath: file,
      encrypt: false,
    });
  }
  if (includeSecrets && config.secretsDir) {
    for (const file of await listRegularFiles(config.secretsDir)) {
      entries.push({
        archivePath: archivePathForFile("secrets", config.secretsDir, file),
        sourcePath: file,
        encrypt: true,
      });
    }
  }
  const writtenManifest = await writeBackupArchive({
    output: createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    entries,
    ...(config.profile && config.profilesRoot
      ? {
          source: {
            installationId: (
              await readFile(resolve(config.profilesRoot, "installation-id"), "utf8").catch(
                () => `unverified-${randomUUID()}`,
              )
            ).trim(),
            profileId: config.profile.id,
            providerHomesDir: resolve(config.stateDir, "provider-homes"),
          },
        }
      : {}),
    appVersion,
    maxArchiveBytes,
    ...(password ? { password } : {}),
  });
  return writtenManifest;
}
