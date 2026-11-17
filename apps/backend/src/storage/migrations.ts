import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backendRoot } from "../config/settings.js";

const BACKUP_DIR_NAME = "backups";
const MAX_BACKUPS = 10;
const REQUIRED_TABLES = ["meta", "sessions", "messages"];

export interface BackupInfo {
  path: string;
  fileName: string;
  reason: string;
  createdAt: string;
  sizeBytes: number;
}

export interface MigrationInfo {
  fromVersion: number;
  toVersion: number;
  applied: number[];
  backupPath: string | null;
}

export interface StorageStatus {
  integrity: "ok";
  schemaVersion: number;
  backupDir: string;
  latestBackup: BackupInfo | null;
  migration: MigrationInfo | null;
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

type Row = Record<string, unknown>;

export function initializeStorage(
  db: DatabaseSync,
  sqlitePath: string,
  existedBeforeOpen: boolean,
): StorageStatus {
  assertIntegrity(db);

  const migrations = loadMigrations();
  const latestVersion = migrations.at(-1)?.version;
  if (latestVersion === undefined) {
    throw new Error("没有可用的数据库迁移");
  }

  const fromVersion = readSchemaVersion(db);
  if (fromVersion > latestVersion) {
    throw new Error(
      `数据库版本 ${fromVersion} 高于当前应用支持的版本 ${latestVersion}，请升级应用后再打开`,
    );
  }

  const hasMigrationTable = tableExists(db, "schema_migrations");
  const pending = migrations.filter(
    (migration) => migration.version > fromVersion,
  );
  const needsBootstrapRecord =
    fromVersion === latestVersion && !hasMigrationTable;
  let backup: BackupInfo | null = null;

  if (
    existedBeforeOpen &&
    (pending.length > 0 || needsBootstrapRecord)
  ) {
    backup = createBackup(
      db,
      sqlitePath,
      `pre-migration-v${fromVersion}-to-v${latestVersion}`,
    );
  }

  ensureMigrationTable(db);
  for (const migration of pending) {
    applyMigration(db, migration);
  }

  if (pending.length === 0 && !migrationExists(db, fromVersion)) {
    recordMigration(db, migrations.find((item) => item.version === fromVersion));
  }

  const toVersion = pending.at(-1)?.version ?? fromVersion;
  setSchemaVersion(db, toVersion);
  db.exec(`PRAGMA user_version = ${toVersion};`);
  assertSchemaVersion(db, toVersion, latestVersion);
  assertIntegrity(db);

  const daily = existedBeforeOpen
    ? ensureDailyBackup(db, sqlitePath)
    : null;
  const latestBackup = latestBackupInfo(sqlitePath);

  return {
    integrity: "ok",
    schemaVersion: toVersion,
    backupDir: backupDirFor(sqlitePath),
    latestBackup: latestBackup ?? daily,
    migration:
      fromVersion === toVersion
        ? null
        : {
            fromVersion,
            toVersion,
            applied: pending.map((migration) => migration.version),
            backupPath: backup?.path ?? null,
          },
  };
}

export function createDatabaseBackup(
  db: DatabaseSync,
  sqlitePath: string,
  reason = "manual",
): BackupInfo | null {
  return createBackup(db, sqlitePath, reason);
}

export function latestDatabaseBackup(
  sqlitePath: string,
): BackupInfo | null {
  return latestBackupInfo(sqlitePath);
}

export function validateDatabaseFile(file: string): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error("备份文件不存在");
  }
  const walExisted = fs.existsSync(`${file}-wal`);
  const shmExisted = fs.existsSync(`${file}-shm`);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    assertIntegrity(db);
    for (const table of REQUIRED_TABLES) {
      if (!tableExists(db, table)) {
        throw new Error(`备份文件缺少必要数据表：${table}`);
      }
    }
  } finally {
    db?.close();
    if (!walExisted) fs.rmSync(`${file}-wal`, { force: true });
    if (!shmExisted) fs.rmSync(`${file}-shm`, { force: true });
  }
}

function loadMigrations(): Migration[] {
  const directory = findMigrationDirectory();
  const migrations = fs
    .readdirSync(directory)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .map((name): Migration => {
      const version = Number.parseInt(name.split("_", 1)[0] ?? "", 10);
      return {
        version,
        name,
        sql: fs.readFileSync(path.join(directory, name), "utf-8"),
      };
    })
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new Error(`数据库迁移目录为空：${directory}`);
  }
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`数据库迁移文件名无效：${migration.name}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`数据库迁移版本重复：${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations;
}

function findMigrationDirectory(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "migrations"),
    path.resolve(backendRoot(), "src", "storage", "migrations"),
    path.resolve(backendRoot(), "dist", "storage", "migrations"),
  ];
  const directory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!directory) {
    throw new Error("找不到数据库迁移目录");
  }
  return directory;
}

function readSchemaVersion(db: DatabaseSync): number {
  const userVersion = readUserVersion(db);
  let metaVersion = 0;
  if (tableExists(db, "meta")) {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as Row | undefined;
    if (row?.value !== undefined) {
      metaVersion = Number(row.value);
      if (!Number.isInteger(metaVersion) || metaVersion < 0) {
        throw new Error(`数据库 schema_version 无效：${String(row.value)}`);
      }
    }
  }
  return Math.max(userVersion, metaVersion);
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Row | undefined;
  const value = Number(row?.user_version ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version INTEGER PRIMARY KEY, " +
      "name TEXT NOT NULL, " +
      "applied_at TEXT NOT NULL" +
      ");",
  );
}

function applyMigration(db: DatabaseSync, migration: Migration): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(migration.sql);
    recordMigration(db, migration);
    setSchemaVersion(db, migration.version);
    db.exec(`PRAGMA user_version = ${migration.version};`);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original migration error.
    }
    throw new Error(
      `数据库迁移失败（${migration.name}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function recordMigration(
  db: DatabaseSync,
  migration: Migration | undefined,
): void {
  if (!migration) return;
  db.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(version) DO UPDATE SET name=excluded.name, applied_at=excluded.applied_at",
  ).run(migration.version, migration.name, new Date().toISOString());
}

function migrationExists(db: DatabaseSync, version: number): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM schema_migrations WHERE version = ?")
    .get(version) as Row | undefined;
  return row?.found === 1;
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

function assertSchemaVersion(
  db: DatabaseSync,
  actual: number,
  latest: number,
): void {
  if (actual > latest) {
    throw new Error(
      `数据库版本 ${actual} 高于当前应用支持的版本 ${latest}`,
    );
  }
  const recorded = readSchemaVersion(db);
  if (recorded !== actual) {
    throw new Error(
      `数据库版本记录不一致：迁移后为 ${actual}，实际记录为 ${recorded}`,
    );
  }
}

function assertIntegrity(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all() as Row[];
  const messages = rows.flatMap((row) =>
    Object.values(row).map((value) => String(value)),
  );
  if (messages.length === 0 || messages.some((message) => message !== "ok")) {
    throw new Error(`数据库完整性检查失败：${messages.join("；") || "未知错误"}`);
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) as Row | undefined;
  return row?.found === 1;
}

function ensureDailyBackup(
  db: DatabaseSync,
  sqlitePath: string,
): BackupInfo | null {
  if (!isFileDatabase(sqlitePath)) return null;
  const date = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(backupDirFor(sqlitePath), `auto-${date}.db`);
  if (fs.existsSync(dailyPath)) return backupInfo(dailyPath, "daily");
  return createBackup(db, sqlitePath, "daily");
}

function createBackup(
  db: DatabaseSync,
  sqlitePath: string,
  reason: string,
): BackupInfo | null {
  if (!isFileDatabase(sqlitePath) || !fs.existsSync(sqlitePath)) return null;

  const directory = backupDirFor(sqlitePath);
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = fileTimestamp(new Date());
  const baseName =
    reason === "daily"
      ? `auto-${timestamp.slice(0, 10)}`
      : `${safeReason(reason)}-${timestamp}`;
  let destination = path.join(directory, `${baseName}.db`);
  let suffix = 1;
  while (fs.existsSync(destination)) {
    destination = path.join(directory, `${baseName}-${suffix}.db`);
    suffix += 1;
  }

  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  fs.copyFileSync(sqlitePath, destination);
  normalizeBackupFile(destination);
  try {
    validateDatabaseFile(destination);
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw new Error(
      `数据库备份校验失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  rotateBackups(directory, destination);
  return backupInfo(destination, reason);
}

function normalizeBackupFile(file: string): void {
  const backup = new DatabaseSync(file);
  try {
    backup.exec("PRAGMA journal_mode = DELETE;");
    backup.exec("PRAGMA quick_check;");
  } finally {
    backup.close();
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
}

function rotateBackups(directory: string, keepPath: string): void {
  const backups = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".db"))
    .map((name) => {
      const file = path.join(directory, name);
      return { file, stat: fs.statSync(file) };
    })
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  for (const [index, entry] of backups.entries()) {
    if (index < MAX_BACKUPS || entry.file === keepPath) continue;
    fs.rmSync(entry.file, { force: true });
  }
}

function latestBackupInfo(sqlitePath: string): BackupInfo | null {
  const directory = backupDirFor(sqlitePath);
  if (!fs.existsSync(directory)) return null;
  const latest = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".db"))
    .flatMap((name) => {
      const file = path.join(directory, name);
      try {
        return [{ file, stat: fs.statSync(file) }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
  if (!latest) return null;
  const reason = latest.file.includes(`${path.sep}auto-`)
    ? "daily"
    : path.basename(latest.file).split("-")[0] ?? "backup";
  return backupInfo(latest.file, reason);
}

function backupInfo(file: string, reason: string): BackupInfo {
  const stat = fs.statSync(file);
  return {
    path: file,
    fileName: path.basename(file),
    reason,
    createdAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

function backupDirFor(sqlitePath: string): string {
  return path.join(path.dirname(sqlitePath), BACKUP_DIR_NAME);
}

function isFileDatabase(sqlitePath: string): boolean {
  return sqlitePath !== ":memory:" && !sqlitePath.startsWith("file::memory:");
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeReason(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "backup"
  );
}
