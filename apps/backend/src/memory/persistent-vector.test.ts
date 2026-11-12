import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backendRoot, loadSettings } from "../config/settings.js";
import { Database } from "../storage/database.js";
import { EmbeddingService } from "./embedding-service.js";

const modelDir = "D:/my_local_model/paraphrase-multilingual-MiniLM-L12-v2";
const addonPath = path.resolve(
  backendRoot(),
  "../../packages/embedding-napi/dist",
  "soul-mate-embedding.node",
);

describe.runIf(fs.existsSync(modelDir) && fs.existsSync(addonPath))(
  "持久向量缓存",
  () => {
    it("新实例启动后直接复用 SQLite 中的向量", async () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-vector-"));
      const settings = loadSettings();
      settings.paths = {
        ...settings.paths,
        data_dir: temp,
        sqlite_path: path.join(temp, "vectors.db"),
        log_dir: path.join(temp, "logs"),
        log_file: path.join(temp, "logs", "backend.log"),
        chroma_dir: path.join(temp, "chroma"),
        documents_dir: path.join(temp, "documents"),
        embed_model_dir: modelDir,
      };
      settings.features.memory = true;
      settings.features.rag = false;
      settings.embedding.kernel = "napi";
      settings.embedding.napi_addon = addonPath;
      const db = new Database(settings);
      const texts = ["持久缓存第一条", "持久缓存第二条"];
      try {
        const first = new EmbeddingService(settings, { database: db });
        const firstVectors = await first.embedTexts(texts);
        expect(firstVectors).toHaveLength(2);
        expect(first.status().persistentCacheMisses).toBe(2);
        const ranked = await first.rankCandidates(
          "我喜欢和你聊天",
          [
            { id: "related", text: "和遐蝶交流让我很开心" },
            { id: "unrelated", text: "服务器硬盘容量是两TB" },
          ],
          2,
        );
        expect(ranked).not.toBeNull();
        expect(ranked!.get("related")!).toBeGreaterThan(
          ranked!.get("unrelated")!,
        );
        expect(first.status().metrics!.indexEntries).toBeGreaterThan(1);
        await first.close();

        const row = db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM embedding_cache",
        );
        expect(Number(row?.n)).toBe(4);

        const second = new EmbeddingService(settings, { database: db });
        try {
          const secondVectors = await second.embedTexts(texts);
          expect(secondVectors).toEqual(firstVectors);
          expect(second.status()).toMatchObject({
            persistentCacheHits: 2,
            persistentCacheMisses: 0,
            persistentCacheEntries: 4,
          });
          expect(second.status().metrics?.completedRequests ?? 0).toBe(0);
        } finally {
          await second.close();
        }
      } finally {
        db.close();
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
