import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../config/settings.js";
import { Database } from "./database.js";

const temporaryDirectories: string[] = [];

function testSettings(): {
  settings: ReturnType<typeof loadSettings>;
  directory: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-storage-"));
  temporaryDirectories.push(directory);
  const settings = loadSettings();
  settings.paths = {
    ...settings.paths,
    data_dir: directory,
    sqlite_path: path.join(directory, "soul_mate.db"),
    log_dir: path.join(directory, "logs"),
    log_file: path.join(directory, "logs", "backend.log"),
    chroma_dir: path.join(directory, "chroma"),
    documents_dir: path.join(directory, "documents"),
  };
  settings.logging.level = "silent";
  return { settings, directory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations and backups", () => {
  it("creates the current schema on a new database", () => {
    const { settings, directory } = testSettings();
    const database = new Database(settings);
    try {
      const health = database.health() as {
        schema_version: string;
        integrity: string;
        backup_dir: string;
        latest_backup: unknown;
      };
      expect(health.schema_version).toBe("3");
      expect(health.integrity).toBe("ok");
      expect(health.backup_dir).toBe(path.join(directory, "backups"));
      expect(health.latest_backup).toBeNull();
    } finally {
      database.close();
    }
  });

  it("creates a daily snapshot when reopening an existing database", () => {
    const { settings, directory } = testSettings();
    const first = new Database(settings);
    first.insertUserMessage("default", "备份中的消息");
    first.close();

    const second = new Database(settings);
    try {
      const health = second.health() as {
        latest_backup: { path: string } | null;
      };
      expect(health.latest_backup?.path).toBeTruthy();
      const backup = new DatabaseSync(health.latest_backup!.path, {
        readOnly: true,
      });
      try {
        const row = backup
          .prepare("SELECT COUNT(*) AS n FROM messages")
          .get() as { n: number };
        expect(Number(row.n)).toBe(1);
      } finally {
        backup.close();
      }
      expect(
        fs.existsSync(path.join(directory, "backups")),
      ).toBe(true);
    } finally {
      second.close();
    }
  });

  it("backs up a legacy database before applying pending migrations", () => {
    const { settings, directory } = testSettings();
    const first = new Database(settings);
    first.insertUserMessage("default", "升级前消息");
    first.close();

    const legacy = new DatabaseSync(settings.paths.sqlite_path);
    try {
      legacy.exec("DROP TABLE schema_migrations;");
      legacy.exec(
        "ALTER TABLE session_summaries DROP COLUMN summarized_through_rowid;",
      );
      legacy.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version';");
      legacy.exec("PRAGMA user_version = 1;");
    } finally {
      legacy.close();
    }

    const upgraded = new Database(settings);
    try {
      const health = upgraded.health() as {
        schema_version: string;
        migration: {
          fromVersion: number;
          toVersion: number;
          backupPath: string;
        } | null;
      };
      expect(health.schema_version).toBe("3");
      expect(health.migration).toMatchObject({
        fromVersion: 1,
        toVersion: 3,
      });
      expect(health.migration?.backupPath).toBeTruthy();
      expect(fs.existsSync(health.migration!.backupPath)).toBe(true);

      const backups = fs
        .readdirSync(path.join(directory, "backups"))
        .filter((name) => name.startsWith("pre-migration-"));
      expect(backups).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });

  it("migrates an existing v2 database and preserves a pre-migration backup", () => {
    const { settings, directory } = testSettings();
    const first = new Database(settings);
    first.close();

    const legacy = new DatabaseSync(settings.paths.sqlite_path);
    try {
      legacy.exec("DROP TABLE schema_migrations;");
      legacy.exec(
        "ALTER TABLE session_summaries DROP COLUMN summarized_through_rowid;",
      );
      legacy.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version';");
      legacy.exec("PRAGMA user_version = 0;");
    } finally {
      legacy.close();
    }

    const adopted = new Database(settings);
    try {
      const health = adopted.health() as {
        schema_version: string;
        migration: {
          fromVersion: number;
          toVersion: number;
        } | null;
      };
      expect(health.schema_version).toBe("3");
      expect(health.migration).toMatchObject({
        fromVersion: 2,
        toVersion: 3,
      });
      const migrations = new DatabaseSync(settings.paths.sqlite_path, {
        readOnly: true,
      });
      try {
        const row = migrations
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .get() as { version: number };
        expect(Number(row.version)).toBe(3);
      } finally {
        migrations.close();
      }
      expect(
        fs
          .readdirSync(path.join(directory, "backups"))
          .filter((name) => name.startsWith("pre-migration-")),
      ).toHaveLength(1);
    } finally {
      adopted.close();
    }
  });

  it("refuses to open a database created by a newer application version", () => {
    const { settings } = testSettings();
    const first = new Database(settings);
    first.close();

    const future = new DatabaseSync(settings.paths.sqlite_path);
    try {
      future.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version';");
      future.exec("PRAGMA user_version = 99;");
    } finally {
      future.close();
    }

    expect(() => new Database(settings)).toThrow(
      "数据库版本 99 高于当前应用支持的版本",
    );
  });
});
