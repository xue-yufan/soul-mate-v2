import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backendRoot, loadSettings } from "../config/settings.js";
import { NativeEmbeddingClient } from "./native-embedding-client.js";

const addonPath = path.resolve(
  backendRoot(),
  "../../packages/embedding-napi/dist/soul-mate-embedding.node",
);
const modelDir = "D:/my_local_model/paraphrase-multilingual-MiniLM-L12-v2";
const available = fs.existsSync(addonPath) && fs.existsSync(modelDir);
const require = createRequire(import.meta.url);

describe.runIf(available)("NativeEmbeddingClient", () => {
  it("通过 Rust N-API 加载模型并排序相关文本", async () => {
    const settings = loadSettings();
    settings.features.memory = true;
    settings.features.rag = false;
    settings.paths.embed_model_dir = modelDir;
    settings.embedding.kernel = "napi";
    settings.embedding.napi_addon = addonPath;
    const client = new NativeEmbeddingClient(settings);
    const longTexts = Array.from(
      { length: 64 },
      (_, index) => `取消测试文本 ${index} ${"内容".repeat(400)}`,
    );
    try {
      await client.start();
      expect(client.status()).toMatchObject({
        loaded: true,
        kernel: "napi",
        dimension: 384,
      });
      const scores = await client.semanticScores("我喜欢和你聊天", [
        "和遐蝶交流让我很开心",
        "服务器硬盘容量是两TB",
      ]);
      expect(scores).not.toBeNull();
      expect(scores![0]!).toBeGreaterThan(scores![1]!);
      const firstStatus = client.status();
      expect(firstStatus.metrics).toMatchObject({
        state: "ready",
        workerLimit: 2,
        queueLimit: 8,
      });
      expect(firstStatus.metrics!.completedRequests).toBeGreaterThan(0);
      expect(firstStatus.metrics!.cacheMisses).toBeGreaterThan(0);
      const queryVector = Array.from({ length: 384 }, (_, index) =>
        index === 0 ? 1 : 0,
      );
      const secondVector = Array.from({ length: 384 }, (_, index) =>
        index === 1 ? 1 : 0,
      );
      client.indexUpsert([
        { id: "first", vector: queryVector },
        { id: "second", vector: secondVector },
      ]);
      expect(client.rankVector(queryVector, ["first", "second"], 2)).toEqual([
        { id: "first", score: 1 },
        { id: "second", score: 0 },
      ]);
      expect(client.status().metrics!.indexEntries).toBe(2);

      await client.semanticScores("我喜欢和你聊天", [
        "和遐蝶交流让我很开心",
        "服务器硬盘容量是两TB",
      ]);
      expect(client.status().metrics!.cacheHits).toBeGreaterThan(
        firstStatus.metrics!.cacheHits,
      );

      const controller = new AbortController();
      controller.abort(new Error("测试取消嵌入"));
      const pending = client.embedTexts(longTexts, controller.signal);
      await expect(pending).rejects.toThrow("测试取消嵌入");
    } finally {
      await client.close();
    }
    expect(client.status().loaded).toBe(false);

    const addon = require(addonPath) as {
      NativeEmbeddingKernel: new () => {
        load(modelDir: string): Promise<number>;
        embed(requestId: string, texts: string[]): Promise<number[][]>;
        cancel(requestId: string): boolean;
        status(): {
          state: string;
          loaded: boolean;
          reason: string | null;
          cancelledRequests: number;
          registeredRequests: number;
        };
        unload(): Promise<void>;
      };
    };
    const kernel = new addon.NativeEmbeddingKernel();
    try {
      await kernel.load(modelDir);
      const pending = kernel.embed("cancel-in-rust", longTexts);
      expect(kernel.cancel("cancel-in-rust")).toBe(true);
      await expect(pending).rejects.toThrow("嵌入请求已取消");
      expect(kernel.status()).toMatchObject({
        cancelledRequests: 1,
        registeredRequests: 0,
      });
    } finally {
      await kernel.unload();
    }

    const failing = new addon.NativeEmbeddingKernel();
    await expect(failing.load("Z:/missing-embedding-model")).rejects.toThrow(
      "嵌入模型文件不存在",
    );
    expect(failing.status()).toMatchObject({
      state: "failed",
      loaded: false,
    });
    expect(failing.status().reason).toContain("嵌入模型文件不存在");
    await failing.unload();
  }, 120_000);
});
