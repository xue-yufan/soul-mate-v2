import crypto from "node:crypto";
import type {
  ChatMessage,
  ModelPort,
  RecallPort,
} from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";
import type { Database } from "../storage/database.js";
import { newId, nowIso } from "../storage/database.js";
import { logAudit } from "../storage/audit.js";
import { lexicalScore, timeDecay } from "./text.js";
import type { EmbeddingClient } from "./embedding-types.js";

export interface MemoryFact {
  id: string;
  type: string;
  content: string;
  importance: number;
  source: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function factFromRow(row: Record<string, unknown>): MemoryFact {
  return {
    id: String(row.id),
    type: String(row.type),
    content: String(row.content),
    importance: Number(row.importance),
    source: typeof row.source === "string" ? row.source : null,
    status: String(row.status),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class MemoryService {
  constructor(
    readonly settings: Settings,
    readonly db: Database,
  ) {}

  list(
    status: string | undefined,
    type: string | undefined,
    limit: number,
    offset: number,
  ) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (type) {
      where.push("type = ?");
      params.push(type);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_facts ${clause}`,
      ...params,
    );
    const rows = this.db.all(
      `SELECT * FROM memory_facts ${clause} ORDER BY created_at DESC ` +
        "LIMIT ? OFFSET ?",
      ...params,
      limit,
      offset,
    );
    return { total: Number(total?.n ?? 0), items: rows.map(factFromRow) };
  }

  get(id: string): MemoryFact | null {
    const row = this.db.get("SELECT * FROM memory_facts WHERE id = ?", id);
    return row ? factFromRow(row) : null;
  }

  update(
    id: string,
    patch: { content?: string; importance?: number; status?: string },
  ): MemoryFact | null {
    const before = this.get(id);
    if (!before) return null;
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.content !== undefined) {
      sets.push("content = ?");
      params.push(patch.content);
    }
    if (patch.importance !== undefined) {
      sets.push("importance = ?");
      params.push(patch.importance);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.run(
      `UPDATE memory_facts SET ${sets.join(", ")} WHERE id = ?`,
      ...params,
    );
    const after = this.get(id);
    if (after) {
      logAudit(this.db, {
        eventType: "memory_fact",
        action: "update",
        targetType: "memory_fact",
        targetId: id,
        before: {
          content: before.content,
          importance: before.importance,
          status: before.status,
        },
        after: {
          content: after.content,
          importance: after.importance,
          status: after.status,
        },
      });
    }
    return after;
  }

  remove(id: string, hard: boolean): boolean {
    const before = this.get(id);
    if (!before) return false;
    if (hard) {
      this.db.run("DELETE FROM memory_facts WHERE id = ?", id);
    } else {
      this.db.run(
        "UPDATE memory_facts SET status = 'deleted', updated_at = ? WHERE id = ?",
        nowIso(),
        id,
      );
    }
    logAudit(this.db, {
      eventType: "memory_fact",
      action: hard ? "delete_hard" : "delete_soft",
      targetType: "memory_fact",
      targetId: id,
      before: {
        content: before.content,
        importance: before.importance,
        status: before.status,
      },
    });
    return true;
  }

  restore(id: string): MemoryFact | null {
    const before = this.get(id);
    if (!before || before.status !== "deleted") return null;
    this.db.run(
      "UPDATE memory_facts SET status = 'active', updated_at = ? WHERE id = ?",
      nowIso(),
      id,
    );
    const restored = this.get(id);
    if (restored) {
      logAudit(this.db, {
        eventType: "memory_fact",
        action: "restore",
        targetType: "memory_fact",
        targetId: id,
        before: { status: before.status },
        after: { status: restored.status },
      });
    }
    return restored;
  }

  storeFact(input: {
    type: string;
    content: string;
    importance: number;
    source?: string | null;
    conflictPolicy?: "persona_first" | "newest_first";
  }): MemoryFact {
    const active = this.db.all(
      "SELECT * FROM memory_facts WHERE status = 'active'",
    );
    const duplicate = active
      .map((row) => ({
        fact: factFromRow(row),
        score: lexicalScore(input.content, String(row.content)),
      }))
      .find((item) => item.score >= 0.92);

    if (duplicate) {
      if (input.conflictPolicy === "newest_first") {
        return (
          this.update(duplicate.fact.id, {
            content: input.content,
            importance: input.importance,
          }) ?? duplicate.fact
        );
      }
      return duplicate.fact;
    }

    const fact: MemoryFact = {
      id: newId(),
      type: input.type,
      content: input.content,
      importance: input.importance,
      source: input.source ?? "conversation",
      status: "active",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.db.run(
      "INSERT INTO memory_facts(id, type, content, importance, source, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
      fact.id,
      fact.type,
      fact.content,
      fact.importance,
      fact.source,
      fact.created_at,
      fact.updated_at,
    );
    return fact;
  }
}

export class RecallService implements RecallPort {
  constructor(
    readonly settings: Settings,
    readonly db: Database,
    readonly embedding?: EmbeddingClient,
  ) {}

  private async blendScores(
    query: string,
    candidates: Array<{
      id: string;
      content: string;
      text: string;
      lexical: number;
      weight?: number;
      boost?: number;
      vectorWeight?: number;
    }>,
    semanticLimit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ content: string; score: number }>> {
    const ranked = this.embedding?.rankCandidates
      ? await this.embedding.rankCandidates(
          query,
          candidates.map((candidate) => ({
            id: candidate.id,
            text: candidate.text,
          })),
          Math.max(1, Math.min(semanticLimit, candidates.length)),
          signal,
        )
      : null;
    const semantic =
      ranked === null && this.embedding
        ? await this.embedding.semanticScores(
            query,
            candidates.map((candidate) => candidate.text),
            signal,
          )
        : null;
    return candidates.map((candidate, index) => {
      const vectorWeight = candidate.vectorWeight ?? 0.45;
      const semanticScore = ranked
        ? (ranked.get(candidate.id) ?? 0)
        : (semantic?.[index] ?? 0);
      const hasSemantic = ranked !== null || semantic !== null;
      const lexicalWeight = hasSemantic ? 1 - vectorWeight : 1;
      const score =
        (candidate.lexical * lexicalWeight +
          semanticScore * (hasSemantic ? vectorWeight : 0) +
          (candidate.boost ?? 0)) *
        (candidate.weight ?? 1);
      return { content: candidate.content, score };
    });
  }

  async recall(query: string, signal?: AbortSignal): Promise<string> {
    if (!query.trim()) return "";
    const groups: Array<{
      title: string;
      items: Array<{ content: string; score: number }>;
    }> = [];

    if (this.settings.features.memory) {
      const allCandidates = this.db
        .all("SELECT * FROM memory_facts WHERE status = 'active'")
        .map((row) => {
          const fact = factFromRow(row);
          return {
            id: fact.id,
            content: `- [${fact.type}] ${fact.content}`,
            text: fact.content,
            lexical: lexicalScore(query, fact.content),
            weight:
              (0.5 + fact.importance * 0.5) *
              timeDecay(fact.created_at, this.settings.memory.time_decay_days),
            vectorWeight: 0.45,
          };
        });
      const candidates = prefilterCandidates(
        allCandidates,
        this.settings.memory.candidate_limit,
      );
      const items = (
        await this.blendScores(
          query,
          candidates,
          Math.max(this.settings.memory.top_k * 4, 64),
          signal,
        )
      )
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.settings.memory.top_k);
      if (items.length > 0) groups.push({ title: "【相关记忆】", items });
    }

    if (this.settings.features.rag) {
      const allEntryCandidates = this.db
        .all("SELECT * FROM worldbook WHERE status = 'active'")
        .map((row) => {
          const keywords = String(row.keywords ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          const keywordHit = keywords.some((keyword) =>
            query.includes(keyword),
          );
          return {
            id: String(row.id),
            content: `- ${String(row.title)}：${String(row.content)}`,
            text: `${String(row.title)} ${keywords.join(" ")} ${String(row.content)}`,
            lexical: lexicalScore(
              query,
              `${String(row.title)} ${keywords.join(" ")} ${String(row.content)}`,
            ),
            boost: keywordHit ? this.settings.rag.worldbook_keyword_boost : 0,
            vectorWeight: 0.45,
          };
        });
      const entryCandidates = prefilterCandidates(
        allEntryCandidates,
        this.settings.rag.candidate_limit,
      );
      const entries = (
        await this.blendScores(
          query,
          entryCandidates,
          Math.max(this.settings.rag.worldbook_top_k * 4, 64),
          signal,
        )
      )
        .filter((item) => item.score >= this.settings.rag.min_similarity)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.settings.rag.worldbook_top_k);
      if (entries.length > 0)
        groups.push({ title: "【世界设定】", items: entries });

      const allChunkCandidates = this.db
        .all(
          "SELECT c.id, c.content, d.title FROM document_chunks c " +
            "JOIN documents d ON d.id = c.document_id WHERE d.status = 'active'",
        )
        .map((row) => ({
          id: String(row.id),
          content: `- 《${String(row.title)}》：${String(row.content)}`,
          text: String(row.content),
          lexical: lexicalScore(query, String(row.content)),
          vectorWeight: 0.65,
        }));
      const chunkCandidates = prefilterCandidates(
        allChunkCandidates,
        this.settings.rag.candidate_limit,
      );
      const chunks = (
        await this.blendScores(
          query,
          chunkCandidates,
          Math.max(this.settings.rag.top_k * 4, 64),
          signal,
        )
      )
        .filter((item) => item.score >= this.settings.rag.min_similarity)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.settings.rag.top_k);
      if (chunks.length > 0)
        groups.push({ title: "【参考资料】", items: chunks });
    }

    return groups
      .map(
        (group) =>
          `${group.title}\n${group.items.map((item) => item.content).join("\n")}`,
      )
      .join("\n\n");
  }
}

export function prefilterCandidates<
  T extends {
    lexical: number;
    weight?: number;
    boost?: number;
  },
>(candidates: T[], limit: number): T[] {
  if (candidates.length <= limit) return candidates;
  return [...candidates]
    .sort((left, right) => {
      const leftScore =
        left.lexical + (left.boost ?? 0) + (left.weight ?? 1) * 0.01;
      const rightScore =
        right.lexical + (right.boost ?? 0) + (right.weight ?? 1) * 0.01;
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

export interface DocumentItem {
  id: string;
  title: string;
  source: string | null;
  mime_type: string | null;
  size_bytes: number;
  chunk_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function documentFromRow(row: Record<string, unknown>): DocumentItem {
  return {
    id: String(row.id),
    title: String(row.title),
    source: typeof row.source === "string" ? row.source : null,
    mime_type: typeof row.mime_type === "string" ? row.mime_type : null,
    size_bytes: Number(row.size_bytes),
    chunk_count: Number(row.chunk_count),
    status: String(row.status),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function splitDocument(
  content: string,
  chunkSize: number,
  overlap: number,
  maxChunks: number,
): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length && chunks.length < maxChunks) {
    let end = Math.min(normalized.length, start + chunkSize);
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
      );
      if (boundary >= Math.floor(chunkSize * 0.55)) {
        end = start + boundary + 1;
      }
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  if (start < normalized.length) {
    throw new Error(
      `文档切块超过上限 ${maxChunks}，请调大 rag.max_chunks_per_doc 或拆分文件`,
    );
  }
  return chunks;
}

export class DocumentService {
  constructor(
    readonly settings: Settings,
    readonly db: Database,
  ) {}

  list(status: string | undefined, limit: number, offset: number) {
    const where = status ? "WHERE status = ?" : "";
    const params = status ? [status] : [];
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM documents ${where}`,
      ...params,
    );
    const rows = this.db.all(
      `SELECT * FROM documents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return { total: Number(total?.n ?? 0), items: rows.map(documentFromRow) };
  }

  get(id: string): DocumentItem | null {
    const row = this.db.get("SELECT * FROM documents WHERE id = ?", id);
    return row ? documentFromRow(row) : null;
  }

  chunks(id: string) {
    return this.db
      .all(
        "SELECT id, chunk_index, content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index",
        id,
      )
      .map((row) => ({
        id: String(row.id),
        index: Number(row.chunk_index),
        content: String(row.content),
      }));
  }

  importText(input: {
    title: string;
    content: string;
    source?: string;
    mime_type?: string;
  }): DocumentItem {
    if (!input.title.trim()) throw new Error("title 不能为空");
    if (!input.content.trim()) throw new Error("content 不能为空");
    const hash = crypto
      .createHash("sha256")
      .update(input.content)
      .digest("hex");
    const existing = this.db.get(
      "SELECT * FROM documents WHERE content_hash = ? AND status = 'active'",
      hash,
    );
    if (existing) return documentFromRow(existing);

    const chunks = splitDocument(
      input.content,
      this.settings.rag.chunk_size,
      this.settings.rag.chunk_overlap,
      this.settings.rag.max_chunks_per_doc,
    );
    if (chunks.length === 0) throw new Error("文档没有可导入的文本");
    const now = nowIso();
    const id = newId();
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO documents(id, title, source, mime_type, size_bytes, chunk_count, " +
          "content_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
        id,
        input.title.trim(),
        input.source ?? null,
        input.mime_type ?? "text/plain",
        Buffer.byteLength(input.content, "utf8"),
        chunks.length,
        hash,
        now,
        now,
      );
      chunks.forEach((chunk, index) => {
        this.db.run(
          "INSERT INTO document_chunks(id, document_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?, ?)",
          newId(),
          id,
          index,
          chunk,
          now,
        );
      });
    });
    return this.get(id)!;
  }

  update(
    id: string,
    patch: { title?: string; status?: string },
  ): DocumentItem | null {
    const before = this.get(id);
    if (!before) return null;
    const sets: string[] = [];
    const params: string[] = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title);
    }
    if (patch.status !== undefined) {
      if (patch.status === "active") {
        const row = this.db.get<{ content_hash: string | null }>(
          "SELECT content_hash FROM documents WHERE id = ?",
          id,
        );
        if (row?.content_hash) {
          const conflict = this.db.get(
            "SELECT id FROM documents WHERE content_hash = ? AND status = 'active' AND id <> ?",
            row.content_hash,
            id,
          );
          if (conflict) throw new Error("相同内容的活跃文档已存在");
        }
      }
      sets.push("status = ?");
      params.push(patch.status);
    }
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.run(
      `UPDATE documents SET ${sets.join(", ")} WHERE id = ?`,
      ...params,
    );
    return this.get(id);
  }

  remove(id: string, hard: boolean): boolean {
    if (!this.get(id)) return false;
    if (hard) {
      this.db.run("DELETE FROM documents WHERE id = ?", id);
    } else {
      this.db.run(
        "UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?",
        nowIso(),
        id,
      );
    }
    return true;
  }
}

export interface WorldbookEntry {
  id: string;
  title: string;
  keywords: string[];
  content: string;
  importance: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function worldbookFromRow(row: Record<string, unknown>): WorldbookEntry {
  return {
    id: String(row.id),
    title: String(row.title),
    keywords: String(row.keywords ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    content: String(row.content),
    importance: Number(row.importance),
    status: String(row.status),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class WorldbookService {
  constructor(
    readonly settings: Settings,
    readonly db: Database,
  ) {}

  list(status: string | undefined, limit: number, offset: number) {
    const where = status ? "WHERE status = ?" : "";
    const params = status ? [status] : [];
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM worldbook ${where}`,
      ...params,
    );
    const rows = this.db.all(
      `SELECT * FROM worldbook ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return { total: Number(total?.n ?? 0), items: rows.map(worldbookFromRow) };
  }

  get(id: string): WorldbookEntry | null {
    const row = this.db.get("SELECT * FROM worldbook WHERE id = ?", id);
    return row ? worldbookFromRow(row) : null;
  }

  create(input: {
    title: string;
    content: string;
    keywords: string[];
    importance: number;
  }): WorldbookEntry {
    const id = newId();
    const now = nowIso();
    this.db.run(
      "INSERT INTO worldbook(id, title, keywords, content, importance, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
      id,
      input.title.trim(),
      input.keywords.join(","),
      input.content.trim(),
      input.importance,
      now,
      now,
    );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: {
      title?: string;
      content?: string;
      keywords?: string[];
      importance?: number;
      status?: string;
    },
  ): WorldbookEntry | null {
    if (!this.get(id)) return null;
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title);
    }
    if (patch.content !== undefined) {
      sets.push("content = ?");
      params.push(patch.content);
    }
    if (patch.keywords !== undefined) {
      sets.push("keywords = ?");
      params.push(patch.keywords.join(","));
    }
    if (patch.importance !== undefined) {
      sets.push("importance = ?");
      params.push(patch.importance);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.run(
      `UPDATE worldbook SET ${sets.join(", ")} WHERE id = ?`,
      ...params,
    );
    return this.get(id);
  }

  remove(id: string, hard: boolean): boolean {
    if (!this.get(id)) return false;
    if (hard) this.db.run("DELETE FROM worldbook WHERE id = ?", id);
    else {
      this.db.run(
        "UPDATE worldbook SET status = 'deleted', updated_at = ? WHERE id = ?",
        nowIso(),
        id,
      );
    }
    return true;
  }
}

export class MemoryExtractor {
  constructor(
    private readonly settings: Settings,
    private readonly model: ModelPort,
    private readonly memory: MemoryService,
  ) {}

  async extract(userText: string, assistantText: string): Promise<void> {
    if (
      !this.settings.features.memory ||
      !this.settings.memory.extract_per_turn
    ) {
      return;
    }
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "从对话中提取值得长期记住的用户偏好或事实。只输出 JSON 数组；每项包含 type、content、importance(0..1)。没有就输出 []。不得记录敏感凭据。",
      },
      {
        role: "user",
        content: `用户：${userText}\n助手：${assistantText}`,
      },
    ];
    let raw = "";
    try {
      for await (const chunk of this.model.stream(messages, {
        signal: AbortSignal.timeout(20_000),
      })) {
        raw += chunk.delta ?? "";
      }
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start < 0 || end <= start) return;
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const content =
          typeof record.content === "string" ? record.content.trim() : "";
        const importance = Number(record.importance ?? 0.5);
        if (
          !content ||
          !Number.isFinite(importance) ||
          importance < this.settings.memory.min_importance
        ) {
          continue;
        }
        this.memory.storeFact({
          type:
            typeof record.type === "string" ? record.type.slice(0, 40) : "fact",
          content: content.slice(0, 1000),
          importance: Math.max(0, Math.min(1, importance)),
          source: "conversation",
          conflictPolicy: this.settings.memory.conflict_policy,
        });
      }
    } catch (error) {
      console.warn("[记忆] 本轮记忆提取已跳过：", error);
    }
  }
}
