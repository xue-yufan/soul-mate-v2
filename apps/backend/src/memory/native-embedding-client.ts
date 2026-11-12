import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backendRoot, type Settings } from "../config/settings.js";
import {
  semanticScoresFromVectors,
  throwIfAborted,
  type EmbeddingClient,
  type EmbeddingMetrics,
  type EmbeddingStatus,
} from "./embedding-types.js";

interface NativeKernelStatus extends EmbeddingMetrics {
  loaded: boolean;
  dimension: number;
  cacheEntries: number;
  indexEntries: number;
  reason: string | null;
  version: string;
}

interface NativeKernel {
  load(modelDir: string): Promise<number>;
  embed(requestId: string, texts: string[]): Promise<number[][]>;
  cancel(requestId: string): boolean;
  indexUpsert(entries: Array<{ id: string; vector: number[] }>): number;
  indexRemove(ids: string[]): number;
  rankVector(
    query: number[],
    ids: string[],
    limit: number,
  ): Array<{ id: string; score: number }>;
  status(): NativeKernelStatus;
  unload(): Promise<void>;
}

interface NativeAddon {
  NativeEmbeddingKernel: new () => NativeKernel;
}

const require = createRequire(import.meta.url);
const ADDON_FILENAME = "soul-mate-embedding.node";

export class NativeEmbeddingClient implements EmbeddingClient {
  private kernel: NativeKernel | null = null;
  private startPromise: Promise<void> | null = null;
  private loaded = false;
  private reason: string | null = null;
  private dimension: number | null = null;
  private metrics: EmbeddingMetrics | undefined;

  constructor(private readonly settings: Settings) {}

  get enabled(): boolean {
    return (
      (this.settings.features.memory || this.settings.features.rag) &&
      Boolean(this.settings.paths.embed_model_dir)
    );
  }

  private addonPath(): string | null {
    const configured = this.settings.embedding.napi_addon.trim();
    const environment =
      process.env.SOUL_MATE_EMBEDDING_NAPI_ADDON?.trim() || null;
    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    const candidates = [
      configured || null,
      environment,
      path.resolve(
        backendRoot(),
        "../../packages/embedding-napi/dist",
        ADDON_FILENAME,
      ),
      resourcesPath
        ? path.resolve(resourcesPath, "embedding-napi", ADDON_FILENAME)
        : null,
    ].filter((item): item is string => Boolean(item));
    return candidates.find((item) => fs.existsSync(item)) ?? null;
  }

  status(): EmbeddingStatus {
    const addonPath = this.addonPath();
    this.refreshNativeStatus();
    return {
      enabled: this.enabled,
      available: Boolean(this.enabled && addonPath),
      loaded: this.loaded,
      kernel: "napi",
      configuredKernel: this.settings.embedding.kernel,
      command: null,
      addonPath,
      modelDir: this.settings.paths.embed_model_dir,
      dimension: this.dimension,
      reason: this.reason,
      ...(this.metrics ? { metrics: this.metrics } : {}),
    };
  }

  async start(): Promise<void> {
    if (!this.enabled || this.loaded) return;
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const modelDir = this.settings.paths.embed_model_dir;
    if (!modelDir || !fs.existsSync(modelDir)) {
      this.reason = `嵌入模型目录不存在：${modelDir ?? "未配置"}`;
      throw new Error(this.reason);
    }
    const addonPath = this.addonPath();
    if (!addonPath) {
      this.reason = "未找到 Rust N-API 嵌入模块";
      throw new Error(this.reason);
    }

    try {
      console.info(`[嵌入] 正在加载 Rust N-API 模块：${addonPath}`);
      const addon = require(addonPath) as NativeAddon;
      const kernel = new addon.NativeEmbeddingKernel();
      const dimension = await kernel.load(modelDir);
      this.kernel = kernel;
      this.dimension = dimension;
      this.loaded = true;
      this.reason = null;
      this.refreshNativeStatus();
      console.info(`[嵌入] Rust N-API 已就绪，维度：${dimension}`);
    } catch (error) {
      this.loaded = false;
      this.kernel = null;
      this.reason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async embedTexts(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][] | null> {
    if (!this.enabled) return null;
    try {
      await this.start();
      throwIfAborted(signal);
      const unique = [...new Set(texts)];
      const batchSize = Math.max(
        1,
        Math.min(64, this.settings.embedding.batch_size),
      );
      const batches: string[][] = [];
      for (let offset = 0; offset < unique.length; offset += batchSize) {
        batches.push(unique.slice(offset, offset + batchSize));
      }
      const results = new Array<number[][]>(batches.length);
      let nextBatch = 0;
      const worker = async (): Promise<void> => {
        while (nextBatch < batches.length) {
          const index = nextBatch;
          nextBatch += 1;
          throwIfAborted(signal);
          results[index] = await this.embedBatch(batches[index]!, signal);
        }
      };
      await Promise.all([worker(), worker()]);
      const vectors = new Map<string, number[]>();
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex]!;
        const result = results[batchIndex]!;
        if (!Array.isArray(result) || result.length !== batch.length) {
          throw new Error("Rust N-API 嵌入结果数量不匹配");
        }
        for (let index = 0; index < batch.length; index += 1) {
          const vector = result[index];
          if (!Array.isArray(vector)) {
            throw new Error("Rust N-API 嵌入向量格式无效");
          }
          vectors.set(batch[index]!, vector.map(Number));
        }
      }
      const first = unique[0] ? vectors.get(unique[0]) : undefined;
      if (first) this.dimension = first.length;
      this.refreshNativeStatus();
      return texts.map((text) => vectors.get(text) ?? []);
    } catch (error) {
      this.refreshNativeStatus();
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("嵌入请求已取消");
      }
      this.reason = error instanceof Error ? error.message : String(error);
      console.warn("[嵌入] N-API 向量计算失败：", this.reason);
      return null;
    }
  }

  async semanticScores(
    query: string,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[] | null> {
    return semanticScoresFromVectors(
      await this.embedTexts([query, ...texts], signal),
      texts.length,
    );
  }

  indexUpsert(entries: Array<{ id: string; vector: number[] }>): void {
    if (!this.kernel || !this.loaded) {
      throw new Error("Rust N-API 嵌入内核尚未加载");
    }
    this.kernel.indexUpsert(entries);
    this.refreshNativeStatus();
  }

  indexRemove(ids: string[]): void {
    if (!this.kernel || !this.loaded || ids.length === 0) return;
    this.kernel.indexRemove(ids);
    this.refreshNativeStatus();
  }

  rankVector(
    query: number[],
    ids: string[],
    limit: number,
  ): Array<{ id: string; score: number }> {
    if (!this.kernel || !this.loaded) {
      throw new Error("Rust N-API 嵌入内核尚未加载");
    }
    return this.kernel.rankVector(query, ids, limit);
  }

  private async embedBatch(
    batch: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const requestId = crypto.randomUUID();
    let cancelTimer: NodeJS.Timeout | null = null;
    const cancel = () => {
      try {
        this.kernel?.cancel(requestId);
      } catch {
        // 请求可能已经完成并释放。
      }
      if (!cancelTimer) {
        cancelTimer = setInterval(() => {
          try {
            this.kernel?.cancel(requestId);
          } catch {
            // 请求可能已经完成并释放。
          }
        }, 5);
        cancelTimer.unref?.();
      }
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.kernel!.embed(requestId, batch);
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (cancelTimer) clearInterval(cancelTimer);
    }
  }

  private refreshNativeStatus(): void {
    try {
      const status = this.kernel?.status();
      if (!status) return;
      this.loaded = status.loaded && status.state === "ready";
      this.dimension = status.dimension || this.dimension;
      this.reason = status.reason;
      this.metrics = {
        state: status.state,
        activeRequests: status.activeRequests,
        queuedRequests: status.queuedRequests,
        registeredRequests: status.registeredRequests,
        completedRequests: status.completedRequests,
        cancelledRequests: status.cancelledRequests,
        failedRequests: status.failedRequests,
        rejectedRequests: status.rejectedRequests,
        cacheHits: status.cacheHits,
        cacheMisses: status.cacheMisses,
        indexEntries: status.indexEntries,
        averageInferenceMs: status.averageInferenceMs,
        lastInferenceMs: status.lastInferenceMs,
        loadMs: status.loadMs,
        workerLimit: status.workerLimit,
        queueLimit: status.queueLimit,
      };
    } catch {
      // 状态查询不能影响主推理流程。
    }
  }

  async close(): Promise<void> {
    try {
      await this.kernel?.unload();
    } finally {
      this.kernel = null;
      this.loaded = false;
      this.metrics = undefined;
    }
  }
}
