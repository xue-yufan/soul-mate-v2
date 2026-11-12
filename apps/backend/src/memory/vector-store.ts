import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../config/settings.js";
import { nowIso, type Database } from "../storage/database.js";

const MAX_CACHE_ROWS = 20_000;

export class PersistentVectorStore {
  readonly modelFingerprint: string;

  constructor(
    private readonly db: Database,
    settings: Settings,
  ) {
    this.modelFingerprint = modelFingerprint(settings.paths.embed_model_dir);
    this.prune();
  }

  keyForText(text: string): string {
    return crypto
      .createHash("sha256")
      .update(this.modelFingerprint)
      .update("\0")
      .update(text)
      .digest("hex");
  }

  getMany(texts: readonly string[]): Map<string, number[]> {
    const found = new Map<string, number[]>();
    const keys = [...new Set(texts.map((text) => this.keyForText(text)))];
    for (let offset = 0; offset < keys.length; offset += 400) {
      const chunk = keys.slice(offset, offset + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db.all<{
        key: string;
        dimension: number;
        vector: Uint8Array;
      }>(
        `SELECT key, dimension, vector FROM embedding_cache ` +
          `WHERE model_fingerprint = ? AND key IN (${placeholders})`,
        this.modelFingerprint,
        ...chunk,
      );
      for (const row of rows) {
        try {
          const vector = decodeVector(row.vector, Number(row.dimension));
          if (vector.length === Number(row.dimension)) {
            found.set(String(row.key), vector);
          }
        } catch {
          this.db.run(
            "DELETE FROM embedding_cache WHERE key = ?",
            String(row.key),
          );
        }
      }
    }
    return found;
  }

  putMany(texts: readonly string[], vectors: readonly number[][]): void {
    if (texts.length !== vectors.length) {
      throw new Error("向量持久化数量与文本数量不一致");
    }
    const now = nowIso();
    this.db.transaction(() => {
      for (let index = 0; index < texts.length; index += 1) {
        const text = texts[index]!;
        const vector = vectors[index];
        if (!vector || vector.length === 0) continue;
        const key = this.keyForText(text);
        const textHash = crypto.createHash("sha256").update(text).digest("hex");
        this.db.run(
          "INSERT INTO embedding_cache(key, model_fingerprint, text_hash, dimension, vector, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET dimension=excluded.dimension, vector=excluded.vector, updated_at=excluded.updated_at",
          key,
          this.modelFingerprint,
          textHash,
          vector.length,
          encodeVector(vector),
          now,
          now,
        );
      }
    });
  }

  count(): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM embedding_cache WHERE model_fingerprint = ?",
      this.modelFingerprint,
    );
    return Number(row?.n ?? 0);
  }

  prune(): void {
    this.db.run(
      "DELETE FROM embedding_cache WHERE model_fingerprint <> ?",
      this.modelFingerprint,
    );
    const count = this.count();
    if (count <= MAX_CACHE_ROWS) return;
    this.db.run(
      "DELETE FROM embedding_cache WHERE key IN (" +
        "SELECT key FROM embedding_cache WHERE model_fingerprint = ? " +
        "ORDER BY updated_at ASC LIMIT ?)",
      this.modelFingerprint,
      count - MAX_CACHE_ROWS,
    );
  }
}

function modelFingerprint(modelDir: string | null): string {
  if (!modelDir) throw new Error("未配置嵌入模型目录");
  const files = ["config.json", "tokenizer.json", "model.safetensors"];
  const hash = crypto.createHash("sha256").update(path.resolve(modelDir));
  for (const name of files) {
    const file = path.join(modelDir, name);
    try {
      const stat = fs.statSync(file);
      hash.update(`\0${name}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`);
    } catch {
      hash.update(`\0${name}\0missing`);
    }
  }
  return hash.digest("hex");
}

function encodeVector(vector: readonly number[]): Uint8Array {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * 4);
  }
  return buffer;
}

function decodeVector(bytes: Uint8Array, dimension: number): number[] {
  if (bytes.byteLength !== dimension * 4) {
    throw new Error("向量 BLOB 长度与维度不一致");
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Array<number>(dimension);
  for (let index = 0; index < dimension; index += 1) {
    vector[index] = buffer.readFloatLE(index * 4);
  }
  return vector;
}
