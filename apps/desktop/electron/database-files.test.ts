import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointDatabase, removeSidecarFiles, validateDatabaseFile } from "./database-files";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-dbfile-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop database file validation", () => {
  it("accepts a valid Soul Mate database without leaving WAL sidecars", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "valid.db");
    const database = new DatabaseSync(file);
    try {
      database.exec(`
                PRAGMA journal_mode = WAL;
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE sessions (id TEXT PRIMARY KEY);
                CREATE TABLE messages (id TEXT PRIMARY KEY);
            `);
    } finally {
      database.close();
    }

    expect(() => validateDatabaseFile(file)).not.toThrow();
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);

    checkpointDatabase(file);
    removeSidecarFiles(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("rejects a non-SQLite file", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "invalid.db");
    fs.writeFileSync(file, "这不是数据库");
    expect(() => validateDatabaseFile(file)).toThrow();
  });

  it("rejects a database without required application tables", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "incomplete.db");
    const database = new DatabaseSync(file);
    try {
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    } finally {
      database.close();
    }
    expect(() => validateDatabaseFile(file)).toThrow("缺少必要数据表");
  });
});
