import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { HttpError, queryInt, queryString, requireFeature } from "./errors.js";
import { listAudit } from "../storage/audit.js";
import { inspectRuntimeModules } from "../diagnostics.js";

export function registerDataRoutes(
  app: FastifyInstance,
  runtime: Runtime,
): void {
  app.get("/healthz", async () => ({
    status: "ok",
    app: runtime.settings.app.name,
    version: runtime.settings.app.version,
    pid: process.pid,
    boot_id: runtime.bootId,
  }));

  app.get("/health", async () => {
    const database = runtime.database.health();
    const modules = await inspectRuntimeModules(runtime);
    return {
      status: database.status === "ok" ? "ok" : "error",
      app: runtime.settings.app.name,
      version: runtime.settings.app.version,
      pid: process.pid,
      boot_id: runtime.bootId,
      time: new Date().toISOString(),
      uptime_s: Math.floor((Date.now() - runtime.startedAt) / 1000),
      checks: {
        database,
        modules: Object.fromEntries(
          modules.map((module) => [module.id, module]),
        ),
      },
    };
  });

  app.get("/history/messages", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = queryInt(query.limit, 100, 1, 1000);
    const offset = queryInt(query.offset, 0, 0, 1_000_000);
    const sessionId = runtime.settings.agent.default_session_id;
    const items = runtime.database
      .listMessages(sessionId, limit, offset)
      .map((row) => {
        const item: Record<string, unknown> = {
          id: row.id,
          role: row.role,
          content: row.content,
          created_at: row.created_at,
          tokens_in: Number(row.tokens_in ?? 0),
          tokens_out: Number(row.tokens_out ?? 0),
          model: row.model ?? "",
        };
        if (row.role === "assistant" && typeof row.tool_calls === "string") {
          try {
            item.tool_calls = JSON.parse(row.tool_calls);
          } catch {
            // ignore malformed legacy rows
          }
        }
        if (row.role === "tool") {
          item.tool_call_id = row.tool_call_id ?? null;
          item.name = row.name ?? null;
          item.status = row.status ?? null;
        }
        return item;
      });
    return { total: runtime.database.countMessages(sessionId), items };
  });

  app.delete("/history/messages", async () => {
    const sessionId = runtime.settings.agent.default_session_id;
    const deleted = runtime.database.transaction(() => {
      const count = runtime.database.run(
        "DELETE FROM messages WHERE session_id = ?",
        sessionId,
      );
      runtime.database.run(
        "DELETE FROM session_summaries WHERE session_id = ?",
        sessionId,
      );
      return count;
    });
    return { ok: true, deleted };
  });

  app.post("/history/regenerate", async () => {
    const sessionId = runtime.settings.agent.default_session_id;
    const result = runtime.database.truncateLastTurn(sessionId);
    if (!result) throw new HttpError(409, "没有可重新生成的用户消息");
    return result;
  });

  app.get("/memory/facts", async (request) => {
    requireFeature(runtime.settings.features.memory, "记忆模块未开启（features.memory=false）");
    const query = request.query as Record<string, unknown>;
    return runtime.memory.list(
      queryString(query.status),
      queryString(query.type),
      queryInt(query.limit, 100, 1, 500),
      queryInt(query.offset, 0, 0, 1_000_000),
    );
  });

  app.get("/memory/facts/:id", async (request) => {
    requireFeature(runtime.settings.features.memory, "记忆模块未开启（features.memory=false）");
    const fact = runtime.memory.get((request.params as { id: string }).id);
    if (!fact) throw new HttpError(404, "记忆不存在");
    return fact;
  });

  app.patch("/memory/facts/:id", async (request) => {
    requireFeature(runtime.settings.features.memory, "记忆模块未开启（features.memory=false）");
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as {
      content?: string;
      importance?: number;
      status?: "active" | "archived" | "deleted";
    };
    if (
      body.content === undefined &&
      body.importance === undefined &&
      body.status === undefined
    ) {
      throw new HttpError(400, "至少提供一个可更新字段");
    }
    const updated = runtime.memory.update(id, body);
    if (!updated) throw new HttpError(404, "记忆不存在");
    return updated;
  });

  app.delete("/memory/facts/:id", async (request) => {
    requireFeature(runtime.settings.features.memory, "记忆模块未开启（features.memory=false）");
    const id = (request.params as { id: string }).id;
    const hard = String((request.query as { hard?: unknown }).hard) === "true";
    if (!runtime.memory.remove(id, hard)) {
      throw new HttpError(404, "记忆不存在");
    }
    return { ok: true, id, hard };
  });

  app.post("/memory/facts/:id/restore", async (request) => {
    requireFeature(runtime.settings.features.memory, "记忆模块未开启（features.memory=false）");
    const id = (request.params as { id: string }).id;
    const restored = runtime.memory.restore(id);
    if (!restored) throw new HttpError(400, "只有 deleted 状态可恢复");
    return restored;
  });

  app.get("/memory/audit", async (request) => {
    requireFeature(runtime.settings.features.memory, "记忆模块未开启（features.memory=false）");
    const query = request.query as Record<string, unknown>;
    const eventType =
      queryString(query.event_type) === "all"
        ? undefined
        : (queryString(query.event_type) ?? "memory_fact");
    return listAudit(runtime.database, {
      ...(eventType ? { eventType } : {}),
      ...(queryString(query.target_id)
        ? { targetId: queryString(query.target_id)! }
        : {}),
      limit: queryInt(query.limit, 50, 1, 500),
      offset: queryInt(query.offset, 0, 0, 1_000_000),
    });
  });

  app.get("/documents", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const query = request.query as Record<string, unknown>;
    const rawStatus = query.status;
    const status =
      rawStatus === undefined ? "active" : rawStatus === "" ? undefined : String(rawStatus);
    return runtime.documents.list(
      status,
      queryInt(query.limit, 100, 1, 500),
      queryInt(query.offset, 0, 0, 1_000_000),
    );
  });

  app.get("/documents/:id", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const doc = runtime.documents.get((request.params as { id: string }).id);
    if (!doc) throw new HttpError(404, "文档不存在");
    return doc;
  });

  app.get("/documents/:id/chunks", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const id = (request.params as { id: string }).id;
    if (!runtime.documents.get(id)) throw new HttpError(404, "文档不存在");
    return runtime.documents.chunks(id);
  });

  app.post("/documents", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const body = request.body as {
      title?: string;
      content?: string;
      source?: string;
      mime_type?: string;
    };
    if (typeof body?.title !== "string" || typeof body?.content !== "string") {
      throw new HttpError(400, "title 和 content 必须是字符串");
    }
    try {
      return runtime.documents.importText({
        title: body.title,
        content: body.content,
        ...(body.source ? { source: body.source } : {}),
        ...(body.mime_type ? { mime_type: body.mime_type } : {}),
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  });

  app.patch("/documents/:id", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { title?: string; status?: string };
    if (body.title === undefined && body.status === undefined) {
      throw new HttpError(400, "至少提供一个可更新字段");
    }
    try {
      const updated = runtime.documents.update(id, body);
      if (!updated) throw new HttpError(404, "文档不存在");
      return updated;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(message.includes("已存在") ? 409 : 400, message);
    }
  });

  app.delete("/documents/:id", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const id = (request.params as { id: string }).id;
    const hard = String((request.query as { hard?: unknown }).hard) === "true";
    if (!runtime.documents.remove(id, hard)) {
      throw new HttpError(404, "文档不存在");
    }
    return { ok: true, id, hard };
  });

  app.get("/worldbook", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const query = request.query as Record<string, unknown>;
    const rawStatus = query.status;
    const status =
      rawStatus === undefined ? "active" : rawStatus === "" ? undefined : String(rawStatus);
    return runtime.worldbook.list(
      status,
      queryInt(query.limit, 100, 1, 500),
      queryInt(query.offset, 0, 0, 1_000_000),
    );
  });

  app.get("/worldbook/:id", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const entry = runtime.worldbook.get((request.params as { id: string }).id);
    if (!entry) throw new HttpError(404, "条目不存在");
    return entry;
  });

  app.post("/worldbook", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const body = request.body as {
      title?: string;
      content?: string;
      keywords?: string[];
      importance?: number;
    };
    if (
      typeof body?.title !== "string" ||
      typeof body?.content !== "string" ||
      !Array.isArray(body?.keywords)
    ) {
      throw new HttpError(400, "title、content、keywords 格式不正确");
    }
    return runtime.worldbook.create({
      title: body.title,
      content: body.content,
      keywords: body.keywords.map(String),
      importance: Number(body.importance ?? 0.7),
    });
  });

  app.patch("/worldbook/:id", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, "至少提供一个可更新字段");
    }
    const updated = runtime.worldbook.update(id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.content === "string" ? { content: body.content } : {}),
      ...(Array.isArray(body.keywords)
        ? { keywords: body.keywords.map(String) }
        : {}),
      ...(body.importance !== undefined
        ? { importance: Number(body.importance) }
        : {}),
      ...(typeof body.status === "string" ? { status: body.status } : {}),
    });
    if (!updated) throw new HttpError(404, "条目不存在");
    return updated;
  });

  app.delete("/worldbook/:id", async (request) => {
    requireFeature(runtime.settings.features.rag, "RAG 模块未开启（features.rag=false）");
    const id = (request.params as { id: string }).id;
    const hard = String((request.query as { hard?: unknown }).hard) === "true";
    if (!runtime.worldbook.remove(id, hard)) {
      throw new HttpError(404, "条目不存在");
    }
    return { ok: true, id, hard };
  });
}
