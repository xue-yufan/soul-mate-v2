import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, PersistedAgentMessage } from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";
import { stripEmotionPrefix } from "@soul-mate/agent-ts";
import {
  createDatabaseBackup,
  initializeStorage,
  latestDatabaseBackup,
  type BackupInfo,
  type StorageStatus,
} from "./migrations.js";

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID().replaceAll("-", "");

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;

export interface SummaryState {
  summary: string | null;
  summarizedThroughRowId: number;
  updatedAt: string | null;
}

export interface SummaryMessage {
  rowId: number;
  role: "user" | "assistant";
  content: string;
}

export class Database {
  private readonly db: DatabaseSync;
  private storage: StorageStatus;

  constructor(private readonly settings: Settings) {
    fs.mkdirSync(path.dirname(settings.paths.sqlite_path), { recursive: true });
    const existedBeforeOpen =
      fs.existsSync(settings.paths.sqlite_path) &&
      fs.statSync(settings.paths.sqlite_path).size > 0;
    this.db = new DatabaseSync(settings.paths.sqlite_path, {
      timeout: Math.round(settings.database.timeout_s * 1000),
    });
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.storage = initializeStorage(
        this.db,
        settings.paths.sqlite_path,
        existedBeforeOpen,
      );
      this.ensureSession(settings.agent.default_session_id);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  run(sql: string, ...params: SqlValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureSession(sessionId: string): void {
    const now = nowIso();
    this.run(
      "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      sessionId,
      sessionId,
      now,
      now,
    );
  }

  countMessages(sessionId: string): number {
    const row = this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages " +
        "WHERE session_id = ? AND role IN ('user', 'assistant', 'tool')",
      sessionId,
    );
    return Number(row?.n ?? 0);
  }

  truncateLastTurn(
    sessionId: string,
  ): { text: string; deleted: number } | null {
    const latestUser = this.get<{ row_id: number; content: string }>(
      "SELECT rowid AS row_id, content FROM messages " +
        "WHERE session_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1",
      sessionId,
    );
    if (!latestUser) return null;

    const deleted = this.transaction(() => {
      const count = this.run(
        "DELETE FROM messages WHERE session_id = ? AND rowid >= ?",
        sessionId,
        latestUser.row_id,
      );
      this.run(
        "DELETE FROM session_summaries WHERE session_id = ?",
        sessionId,
      );
      return count;
    });
    return { text: String(latestUser.content), deleted };
  }

  listMessages(sessionId: string, limit: number, offset: number): Row[] {
    const rows = this.all(
      "SELECT id, role, content, created_at, tokens_in, tokens_out, model, " +
        "tool_call_id, name, tool_calls, status FROM messages " +
        "WHERE session_id = ? AND role IN ('user', 'assistant', 'tool') " +
        "ORDER BY created_at DESC LIMIT ? OFFSET ?",
      sessionId,
      limit,
      offset,
    );
    return rows.reverse();
  }

  loadRecentMessages(
    sessionId: string,
    maxTurns: number,
    excludeMessageId?: string,
  ): ChatMessage[] {
    if (maxTurns <= 0) return [];
    const userParams: SqlValue[] = [sessionId];
    let userWhere = "session_id = ? AND role = 'user'";
    if (excludeMessageId) {
      userWhere += " AND id <> ?";
      userParams.push(excludeMessageId);
    }
    userParams.push(maxTurns);

    const messageParams: SqlValue[] = [sessionId];
    let messageWhere =
      "session_id = ? AND role IN ('user', 'assistant', 'tool')";
    if (excludeMessageId) {
      messageWhere += " AND id <> ?";
      messageParams.push(excludeMessageId);
    }

    const rows = this.all(
      `WITH recent_users AS (` +
        `SELECT rowid AS turn_rowid FROM messages WHERE ${userWhere} ` +
        `ORDER BY rowid DESC LIMIT ?` +
        `) SELECT role, content, name, tool_call_id, tool_calls FROM messages ` +
        `WHERE ${messageWhere} AND rowid >= ` +
        `(SELECT MIN(turn_rowid) FROM recent_users) ORDER BY rowid ASC`,
      ...userParams,
      ...messageParams,
    );

    return rows.flatMap((row) => {
      const role = String(row.role);
      if (!["user", "assistant", "tool"].includes(role)) return [];
      const item: ChatMessage = {
        role: role as ChatMessage["role"],
        content: String(row.content ?? ""),
      };
      if (typeof row.name === "string") item.name = row.name;
      if (typeof row.tool_call_id === "string") item.toolCallId = row.tool_call_id;
      if (role === "assistant" && typeof row.tool_calls === "string") {
        try {
          const parsed: unknown = JSON.parse(row.tool_calls);
          if (Array.isArray(parsed)) {
            item.toolCalls = parsed.map((call) => ({
              id: String((call as { id?: unknown }).id ?? ""),
              name: String((call as { name?: unknown }).name ?? ""),
              arguments: JSON.stringify(
                (call as { args?: unknown; arguments?: unknown }).args ??
                  (call as { arguments?: unknown }).arguments ??
                  {},
              ),
            }));
          }
        } catch {
          // Ignore legacy malformed tool call JSON.
        }
      }
      return [item];
    });
  }

  loadSummary(sessionId: string): string | null {
    return this.loadSummaryState(sessionId).summary;
  }

  loadSummaryState(sessionId: string): SummaryState {
    const row = this.get<{
      summary: string;
      summarized_through_rowid: number;
      updated_at: string;
    }>(
      "SELECT summary, summarized_through_rowid, updated_at " +
        "FROM session_summaries WHERE session_id = ?",
      sessionId,
    );
    return {
      summary: row?.summary ?? null,
      summarizedThroughRowId: Number(row?.summarized_through_rowid ?? 0),
      updatedAt: row?.updated_at ?? null,
    };
  }

  saveSummary(
    sessionId: string,
    summary: string,
    summarizedThroughRowId = 0,
  ): void {
    this.run(
      "INSERT INTO session_summaries(" +
        "session_id, summary, summarized_through_rowid, updated_at" +
        ") VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET " +
        "summary=excluded.summary, " +
        "summarized_through_rowid=excluded.summarized_through_rowid, " +
        "updated_at=excluded.updated_at",
      sessionId,
      summary,
      summarizedThroughRowId,
      nowIso(),
    );
  }

  loadRecentSummaryMessages(
    sessionId: string,
    maxTurns: number,
  ): SummaryMessage[] {
    if (maxTurns <= 0) return [];
    const rows = this.all(
      "WITH recent_users AS (" +
        "SELECT rowid AS turn_rowid FROM messages " +
        "WHERE session_id = ? AND role = 'user' " +
        "ORDER BY rowid DESC LIMIT ?" +
        ") SELECT rowid AS row_id, role, content FROM messages " +
        "WHERE session_id = ? AND role IN ('user', 'assistant') " +
        "AND rowid >= (SELECT MIN(turn_rowid) FROM recent_users) " +
        "ORDER BY rowid ASC",
      sessionId,
      maxTurns,
      sessionId,
    );
    return rows.map(summaryMessageFromRow);
  }

  summaryKeepBoundary(sessionId: string, keepTurns: number): number | null {
    if (keepTurns <= 0) return null;
    const rows = this.all<{ row_id: number }>(
      "SELECT rowid AS row_id FROM messages " +
        "WHERE session_id = ? AND role = 'user' " +
        "ORDER BY rowid DESC LIMIT ?",
      sessionId,
      keepTurns,
    );
    if (rows.length === 0) return 0;
    return Number(rows.at(-1)?.row_id ?? 0);
  }

  loadPendingSummaryMessages(
    sessionId: string,
    afterRowId: number,
    beforeRowId: number | null,
    limit = 200,
  ): SummaryMessage[] {
    const params: SqlValue[] = [sessionId, afterRowId];
    let sql =
      "SELECT rowid AS row_id, role, content FROM messages " +
      "WHERE session_id = ? AND role IN ('user', 'assistant') " +
      "AND rowid > ?";
    if (beforeRowId !== null) {
      sql += " AND rowid < ?";
      params.push(beforeRowId);
    }
    sql += " ORDER BY rowid ASC LIMIT ?";
    params.push(limit);
    return this.all(sql, ...params).map(summaryMessageFromRow);
  }

  insertUserMessage(sessionId: string, content: string): string {
    this.ensureSession(sessionId);
    const id = newId();
    this.run(
      "INSERT INTO messages(id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
      id,
      sessionId,
      content,
      nowIso(),
    );
    return id;
  }

  insertAssistantMessage(sessionId: string, content: string): string {
    this.ensureSession(sessionId);
    const id = newId();
    this.run(
      "INSERT INTO messages(id, session_id, role, content, created_at) " +
        "VALUES (?, ?, 'assistant', ?, ?)",
      id,
      sessionId,
      content,
      nowIso(),
    );
    return id;
  }

  persistAgentMessages(
    sessionId: string,
    messages: PersistedAgentMessage[],
    model: string,
    tokensIn: number,
    tokensOut: number,
    lastAssistantId: { value: string | null },
  ): void {
    this.transaction(() => {
      for (const message of messages) {
        if (message.role === "assistant") {
          const id = newId();
          lastAssistantId.value = id;
          this.run(
            "INSERT INTO messages(id, session_id, role, content, tool_calls, created_at, " +
              "tokens_in, tokens_out, model) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)",
            id,
            sessionId,
            stripEmotionPrefix(message.content),
            message.toolCalls?.length
              ? JSON.stringify(
                  message.toolCalls.map((call) => ({
                    id: call.id,
                    name: call.name,
                    args: safeJson(call.arguments),
                  })),
                )
              : null,
            nowIso(),
            tokensIn,
            tokensOut,
            model,
          );
        } else {
          this.run(
            "INSERT INTO messages(id, session_id, role, content, tool_call_id, name, status, created_at) " +
              "VALUES (?, ?, 'tool', ?, ?, ?, ?, ?)",
            newId(),
            sessionId,
            message.content,
            message.toolCallId ?? null,
            message.name ?? null,
            message.content.startsWith("用户拒绝") ? "denied" : "ok",
            nowIso(),
          );
        }
      }
    });
  }

  writeCost(
    sessionId: string,
    messageId: string | null,
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    estimatedCost: number,
    currency: string,
  ): void {
    this.run(
      "INSERT INTO cost_log(session_id, message_id, provider, model, tokens_in, tokens_out, " +
        "estimated_cost, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      messageId,
      provider,
      model,
      tokensIn,
      tokensOut,
      estimatedCost,
      currency,
      nowIso(),
    );
  }

  updateTtsChars(messageId: string, chars: number): void {
    this.run("UPDATE cost_log SET tts_chars = ? WHERE message_id = ?", chars, messageId);
  }

  backup(reason = "manual"): BackupInfo | null {
    const info = createDatabaseBackup(
      this.db,
      this.settings.paths.sqlite_path,
      reason,
    );
    this.storage = {
      ...this.storage,
      latestBackup: latestDatabaseBackup(this.settings.paths.sqlite_path),
    };
    return info;
  }

  health(): Record<string, unknown> {
    try {
      const journal = this.get<{ journal_mode: string }>("PRAGMA journal_mode");
      return {
        status: "ok",
        path: this.settings.paths.sqlite_path,
        schema_version: String(this.storage.schemaVersion),
        journal_mode: journal?.journal_mode ?? "unknown",
        integrity: this.storage.integrity,
        backup_dir: this.storage.backupDir,
        latest_backup: this.storage.latestBackup,
        migration: this.storage.migration,
      };
    } catch (error) {
      return {
        status: "error",
        path: this.settings.paths.sqlite_path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function summaryMessageFromRow(row: Row): SummaryMessage {
  return {
    rowId: Number(row.row_id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
  };
}
