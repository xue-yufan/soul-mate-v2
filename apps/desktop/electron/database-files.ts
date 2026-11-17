import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_TABLES = ["meta", "sessions", "messages"];

export function validateDatabaseFile(file: string): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error("备份文件不存在");
  }
  const walExisted = fs.existsSync(`${file}-wal`);
  const shmExisted = fs.existsSync(`${file}-shm`);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const messages = rows.flatMap((row) => Object.values(row).map((value) => String(value)));
    if (messages.length === 0 || messages.some((message) => message !== "ok")) {
      throw new Error(`SQLite 完整性检查失败：${messages.join("；")}`);
    }
    const tables = new Set(
      (
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const required of REQUIRED_TABLES) {
      if (!tables.has(required)) {
        throw new Error(`备份文件缺少必要数据表：${required}`);
      }
    }
  } finally {
    database?.close();
    if (!walExisted) fs.rmSync(`${file}-wal`, { force: true });
    if (!shmExisted) fs.rmSync(`${file}-shm`, { force: true });
  }
}

export function checkpointDatabase(file: string): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    database.close();
  }
}

export function removeSidecarFiles(databasePath: string): void {
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
}
