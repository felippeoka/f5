import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConfig } from "./config.ts";
import { parseBackupArchive, resolveBackupRestoreLimits } from "./backupArchive.ts";
import { applyPendingRestore, makeBackupService } from "./backupService.ts";
import { backupMaintenanceEffect, runBackupMaintenance } from "./backupMaintenance.ts";
import { withAttachmentRetentionLease } from "./storage/attachmentRetention.ts";
import { listScheduledBackups, runScheduledBackup } from "./storage/scheduledBackups.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "f5-backup-helper-"));
  directories.push(directory);
  const runtime = ManagedRuntime.make(
    ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
  );
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  await runtime.dispose();
  await mkdir(config.attachmentsDir, { recursive: true });
  await mkdir(config.secretsDir!, { recursive: true });
  await writeFile(join(config.attachmentsDir, "owned.txt"), "owned evidence");
  await writeFile(join(config.attachmentsDir, "unowned.txt"), "unowned");
  await writeFile(join(config.secretsDir!, "token"), "private-token");
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE effect_sql_migrations (migration_id INTEGER); INSERT INTO effect_sql_migrations VALUES(55);
    CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('original');
    CREATE TABLE attachments(attachment_id TEXT PRIMARY KEY, final_path TEXT, lifecycle TEXT);
    CREATE TABLE attachment_owners(attachment_id TEXT);
    CREATE TABLE attachment_cleanup_jobs(attachment_id TEXT PRIMARY KEY, path TEXT);
  `);
  db.prepare("INSERT INTO attachments VALUES ('owned', ?, 'ready')").run(
    join(config.attachmentsDir, "owned.txt"),
  );
  db.exec("INSERT INTO attachment_owners VALUES ('owned')");
  // The same basename in an unarchived path must never target owned bytes after restore.
  db.prepare("INSERT INTO attachments VALUES ('unowned', ?, 'deleting')").run(
    join(config.attachmentsDir, "other", "owned.txt"),
  );
  db.prepare("INSERT INTO attachment_cleanup_jobs VALUES ('unowned', ?)").run(
    join(config.attachmentsDir, "other", "owned.txt"),
  );
  return { directory, config, db };
}

describe("backup maintenance process", () => {
  it("exports a consistent snapshot while live writes continue, retaining only owned attachments", async () => {
    const { directory, config, db } = await fixture();
    const stagingDir = join(directory, "export");
    await mkdir(stagingDir);
    let writes = 0;
    const timer = setInterval(() => {
      db.prepare("INSERT INTO marker VALUES (?)").run(`write-${writes++}`);
    }, 5);
    try {
      const manifest = await runBackupMaintenance({ config, stagingDir, includeSecrets: false });
      expect(writes).toBeGreaterThan(0);
      expect(manifest.files.map((file) => file.path)).toContain("attachments/owned.txt");
      expect(manifest.files.map((file) => file.path)).not.toContain("attachments/unowned.txt");
      expect(manifest.files.some((file) => file.path.startsWith("secrets/"))).toBe(false);
      const restored = await parseBackupArchive({
        source: createReadStream(join(stagingDir, "backup.f5backup")),
        stagingDir: join(directory, "restored"),
        limits: resolveBackupRestoreLimits(),
      });
      const snapshot = new DatabaseSync(join(restored.payloadDir, "database.sqlite"), {
        readOnly: true,
      });
      expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(snapshot.prepare("SELECT count(*) AS count FROM marker").get()).toMatchObject({
        count: expect.any(Number),
      });
      snapshot.close();
    } finally {
      clearInterval(timer);
      db.close();
    }
  });

  it("restores attachment ownership into another state directory and can export it again", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const firstStaging = join(directory, "first-export");
    await mkdir(firstStaging);
    const original = await runBackupMaintenance({
      config,
      stagingDir: firstStaging,
      includeSecrets: false,
    });
    const restoredDir = join(directory, "new-profile");
    await mkdir(restoredDir);
    const restored = {
      ...config,
      stateDir: restoredDir,
      dbPath: join(restoredDir, "state.sqlite"),
      attachmentsDir: join(restoredDir, "attachments"),
      settingsPath: join(restoredDir, "settings.json"),
      keybindingsConfigPath: join(restoredDir, "keybindings.json"),
      secretsDir: join(restoredDir, "secrets"),
    };
    const service = await Effect.runPromise(
      makeBackupService.pipe(Effect.provideService(ServerConfig, restored)),
    );
    await Effect.runPromise(
      service.stageRestore({ source: createReadStream(join(firstStaging, "backup.f5backup")) }),
    );
    await applyPendingRestore(restored);
    const registry = new DatabaseSync(restored.dbPath, { readOnly: true });
    try {
      expect(
        registry.prepare("SELECT final_path FROM attachments WHERE attachment_id='owned'").get(),
      ).toEqual({ final_path: join(restored.attachmentsDir, "owned.txt") });
      expect(registry.prepare("SELECT * FROM attachment_owners").all()).toEqual([
        { attachment_id: "owned" },
      ]);
      const cleanup = registry
        .prepare("SELECT path FROM attachment_cleanup_jobs WHERE attachment_id='unowned'")
        .get() as { path: string };
      expect(cleanup.path).toContain(join(restored.attachmentsDir, "__restore_unowned__"));
      expect(cleanup.path).not.toBe(join(restored.attachmentsDir, "owned.txt"));
    } finally {
      registry.close();
    }
    const secondStaging = join(directory, "second-export");
    await mkdir(secondStaging);
    const exported = await runBackupMaintenance({
      config: restored,
      stagingDir: secondStaging,
      includeSecrets: false,
    });
    expect(exported.files.find((file) => file.path === "attachments/owned.txt")?.sha256).toBe(
      original.files.find((file) => file.path === "attachments/owned.txt")?.sha256,
    );
  });

  it("fails export when owned evidence is missing and propagates helper startup errors", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    await rm(join(config.attachmentsDir, "owned.txt"));
    const stagingDir = join(directory, "export");
    await mkdir(stagingDir);
    await expect(
      runBackupMaintenance({ config, stagingDir, includeSecrets: false }),
    ).rejects.toThrow();
    await expect(
      runBackupMaintenance({
        config: { ...config, dbPath: join(directory, "missing.sqlite") },
        stagingDir,
        includeSecrets: false,
      }),
    ).rejects.toThrow();
  });

  it("waits for child termination before a cancelled export releases attachment retention", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const stagingDir = join(directory, "export");
    await mkdir(stagingDir);
    const fiber = Effect.runFork(
      withAttachmentRetentionLease(
        config.attachmentsDir,
        backupMaintenanceEffect({ config, stagingDir, includeSecrets: false }),
      ),
    );
    const { Fiber } = await import("effect");
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(withAttachmentRetentionLease(config.attachmentsDir, Effect.void));
    // Reusing the snapshot destination proves no old child can still install it.
    await runBackupMaintenance({ config, stagingDir, includeSecrets: false });
  });

  it("keeps successful backups when the export exhausts its storage budget", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const backups = join(directory, "backups");
    await mkdir(backups);
    const previous = `daily-${Date.now() - 2 * 86400000}-00000000-0000-0000-0000-000000000000.f5backup`;
    await writeFile(join(backups, previous), "previous success");
    vi.stubEnv("F5_BACKUP_MAX_COMPRESSED_BYTES", "1");
    const backup = await Effect.runPromise(
      makeBackupService.pipe(Effect.provideService(ServerConfig, config)),
    );
    await expect(Effect.runPromise(runScheduledBackup(backup, backups))).rejects.toBeDefined();
    expect(await readdir(backups)).toEqual([previous]);
  });

  it("daily retention keeps seven successful exports and ignores unrelated files", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const backups = join(directory, "backups");
    await mkdir(backups);
    const now = Date.now();
    for (let day = 1; day <= 8; day++)
      await writeFile(
        join(
          backups,
          `daily-${now - day * 86400000}-00000000-0000-0000-0000-000000000000.f5backup`,
        ),
        "previous success",
      );
    await writeFile(join(backups, "manual.f5backup"), "keep");
    const backup = await Effect.runPromise(
      makeBackupService.pipe(Effect.provideService(ServerConfig, config)),
    );
    await Effect.runPromise(runScheduledBackup(backup, backups, now));
    expect(await listScheduledBackups(backups)).toHaveLength(7);
    const names = await readdir(backups);
    expect(names).toContain("manual.f5backup");
    expect(names.some((name) => name.endsWith(".partial"))).toBe(false);
    const before = [...names];
    await Effect.runPromise(runScheduledBackup(backup, backups, now + 1000));
    expect(await readdir(backups)).toEqual(before);
  });
});
