import type { Database } from "./database.js";
import { nowIso } from "./database.js";

export interface AuditWrite {
  eventType: string;
  actor?: string;
  targetType?: string | null;
  targetId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  status?: string;
}

export function logAudit(db: Database, entry: AuditWrite): void {
  db.run(
    "INSERT INTO audit_log(event_type, actor, target_type, target_id, action, " +
      "before_json, after_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    entry.eventType,
    entry.actor ?? "system",
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.action,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.status ?? "ok",
    nowIso(),
  );
}

export function listAudit(
  db: Database,
  options: {
    eventType?: string;
    targetId?: string;
    limit: number;
    offset: number;
  },
): { total: number; items: Record<string, unknown>[] } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.eventType) {
    where.push("event_type = ?");
    params.push(options.eventType);
  }
  if (options.targetId) {
    where.push("target_id = ?");
    params.push(options.targetId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log ${clause}`,
    ...params,
  );
  const rows = db.all(
    `SELECT id, event_type, actor, target_type, target_id, action, before_json, ` +
      `after_json, status, created_at FROM audit_log ${clause} ` +
      `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  return {
    total: Number(totalRow?.n ?? 0),
    items: rows.map((row) => ({
      id: Number(row.id),
      event_type: row.event_type,
      actor: row.actor,
      target_type: row.target_type,
      target_id: row.target_id,
      action: row.action,
      before: parseNullableJson(row.before_json),
      after: parseNullableJson(row.after_json),
      status: row.status,
      created_at: row.created_at,
    })),
  };
}

function parseNullableJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
