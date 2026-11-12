import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, PersistedAgentMessage } from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";
import { backendRoot } from "../config/settings.js";
import { stripEmotionPrefix } from "@soul-mate/agent-ts";

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID().replaceAll("-", "");

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;

export class Database {
  private readonly db: DatabaseSync;

  constructor(private readonly settings: Settings) {
    fs.mkdirSync(path.dirname(settings.paths.sqlite_path), { recursive: true });
    this.db = new DatabaseSync(settings.paths.sqlite_path, {
      timeout: Math.round(settings.database.timeout_s * 1000),
    });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    const schemaCandidates = [
      path.resolve(import.meta.dirname, "schema.sql"),
      path.resolve(backendRoot(), "src", "storage", "schema.sql"),
    ];
    const schemaFile = schemaCandidates.find((candidate) =>
      fs.existsSync(candidate),
    );
    if (!schemaFile) {
      throw new Error("找不到数据库 schema.sql");
    }
    const schema = fs.readFileSync(schemaFile, "utf-8");
    this.db.exec(schema);
    this.ensureSession(settings.agent.default_session_id);
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
    const row = this.get<{ summary: string }>(
      "SELECT summary FROM session_summaries WHERE session_id = ?",
      sessionId,
    );
    return row?.summary ?? null;
  }

  saveSummary(sessionId: string, summary: string): void {
    this.run(
      "INSERT INTO session_summaries(session_id, summary, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET summary=excluded.summary, updated_at=excluded.updated_at",
      sessionId,
      summary,
      nowIso(),
    );
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

  health(): Record<string, unknown> {
    try {
      const version = this.get<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      );
      const journal = this.get<{ journal_mode: string }>("PRAGMA journal_mode");
      return {
        status: "ok",
        path: this.settings.paths.sqlite_path,
        schema_version: version?.value ?? "unknown",
        journal_mode: journal?.journal_mode ?? "unknown",
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
