import type { Settings } from "../config/settings.js";
import type { Database } from "../storage/database.js";
import { RustEmbeddingClient } from "./embedding-client.js";
import type {
  EmbeddingClient,
  EmbeddingStatus,
  RankingCandidate,
} from "./embedding-types.js";
import { semanticScoresFromVectors } from "./embedding-types.js";
import { NativeEmbeddingClient } from "./native-embedding-client.js";
import { PersistentVectorStore } from "./vector-store.js";

interface EmbeddingClients {
  native: EmbeddingClient;
  sidecar: EmbeddingClient;
}

export class EmbeddingService implements EmbeddingClient {
  private readonly native: EmbeddingClient;
  private readonly sidecar: EmbeddingClient;
  private readonly vectorStore: PersistentVectorStore | null;
  private readonly indexedKeys = new Set<string>();
  private active: EmbeddingClient | null = null;
  private startPromise: Promise<void> | null = null;
  private fallbackReason: string | undefined;
  private persistentHits = 0;
  private persistentMisses = 0;
  private storeWrites = 0;

  constructor(
    private readonly settings: Settings,
    options: Partial<EmbeddingClients> & { database?: Database } = {},
  ) {
    this.native = options.native ?? new NativeEmbeddingClient(settings);
    this.sidecar = options.sidecar ?? new RustEmbeddingClient(settings);
    try {
      this.vectorStore =
        options.database && settings.paths.embed_model_dir
          ? new PersistentVectorStore(options.database, settings)
          : null;
    } catch (error) {
      console.warn(
        "[嵌入] 持久化向量缓存不可用：",
        error instanceof Error ? error.message : String(error),
      );
      this.vectorStore = null;
    }
  }

  get enabled(): boolean {
    return this.native.enabled || this.sidecar.enabled;
  }

  status(): EmbeddingStatus {
    const activeStatus = this.active?.status();
    const preferred =
      this.settings.embedding.kernel === "sidecar"
        ? this.sidecar.status()
        : this.native.status();
    return {
      ...(activeStatus ?? preferred),
      configuredKernel: this.settings.embedding.kernel,
      persistentCacheHits: this.persistentHits,
      persistentCacheMisses: this.persistentMisses,
      persistentCacheEntries: this.vectorStore?.count() ?? 0,
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
    };
  }

  async start(): Promise<void> {
    if (!this.enabled || this.active?.status().loaded) return;
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    switch (this.settings.embedding.kernel) {
      case "sidecar":
        await this.sidecar.start();
        this.active = this.sidecar;
        return;
      case "napi":
        await this.native.start();
        this.active = this.native;
        return;
      case "auto":
        try {
          await this.native.start();
          this.active = this.native;
          this.fallbackReason = undefined;
          return;
        } catch (error) {
          this.fallbackReason =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `[嵌入] N-API 不可用，回退 Rust sidecar：${this.fallbackReason}`,
          );
          await this.sidecar.start();
          this.active = this.sidecar;
          this.indexedKeys.clear();
        }
    }
  }

  async embedTexts(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][] | null> {
    if (!this.enabled) return null;
    if (texts.length === 0) return [];
    await this.start();
    if (!this.active) return null;
    if (!this.vectorStore) {
      return this.embedThroughActive(texts, signal);
    }

    const cached = this.vectorStore.getMany(texts);
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
      if (seen.has(text)) continue;
      seen.add(text);
      if (cached.has(this.vectorStore.keyForText(text))) {
        this.persistentHits += 1;
      } else {
        this.persistentMisses += 1;
        missing.push(text);
      }
    }
    if (missing.length > 0) {
      const vectors = await this.embedThroughActive(missing, signal);
      if (!vectors) return null;
      this.vectorStore.putMany(missing, vectors);
      for (let index = 0; index < missing.length; index += 1) {
        const vector = vectors[index];
        if (vector) {
          cached.set(this.vectorStore.keyForText(missing[index]!), vector);
        }
      }
      this.storeWrites += 1;
      if (this.storeWrites % 50 === 0) this.vectorStore.prune();
    }
    return texts.map(
      (text) => cached.get(this.vectorStore!.keyForText(text)) ?? [],
    );
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

  async rankCandidates(
    query: string,
    candidates: readonly RankingCandidate[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<Map<string, number> | null> {
    if (!this.enabled || candidates.length === 0) return new Map();
    await this.start();
    if (!this.active) return null;
    if (!this.active.rankVector || !this.active.indexUpsert) {
      const scores = await this.semanticScores(
        query,
        candidates.map((candidate) => candidate.text),
        signal,
      );
      if (!scores) return null;
      return new Map(
        candidates.map((candidate, index) => [
          candidate.id,
          scores[index] ?? 0,
        ]),
      );
    }

    const keyFor = (candidate: RankingCandidate): string =>
      this.vectorStore?.keyForText(candidate.text) ?? candidate.id;
    if (this.indexedKeys.size > 50_000) {
      this.active.indexRemove?.([...this.indexedKeys]);
      this.indexedKeys.clear();
    }
    const unique = new Map<string, RankingCandidate>();
    for (const candidate of candidates)
      unique.set(keyFor(candidate), candidate);

    const cached = this.vectorStore
      ? this.vectorStore.getMany(
          [...unique.values()].map((candidate) => candidate.text),
        )
      : new Map<string, number[]>();
    this.upsertIndex(
      [...cached.entries()]
        .filter(([key]) => !this.indexedKeys.has(key))
        .map(([id, vector]) => ({ id, vector })),
    );

    const missing = [...unique.entries()]
      .filter(([key]) => !cached.has(key) && !this.indexedKeys.has(key))
      .map(([, candidate]) => candidate);
    if (missing.length > 0) {
      const vectors = await this.embedTexts(
        missing.map((candidate) => candidate.text),
        signal,
      );
      if (!vectors) return null;
      const entries = missing.flatMap((candidate, index) => {
        const vector = vectors[index];
        return vector ? [{ id: keyFor(candidate), vector }] : [];
      });
      this.upsertIndex(entries);
    }

    const queryVector = (await this.embedThroughActive([query], signal))?.[0];
    if (!queryVector) return null;
    const ranked = this.active.rankVector(
      queryVector,
      [...unique.keys()],
      Math.max(1, Math.min(limit, unique.size)),
    );
    const byKey = new Map(ranked.map((item) => [item.id, item.score]));
    return new Map(
      candidates.map((candidate) => [
        candidate.id,
        byKey.get(keyFor(candidate)) ?? 0,
      ]),
    );
  }

  async close(): Promise<void> {
    await Promise.all([this.native.close(), this.sidecar.close()]);
    this.active = null;
    this.indexedKeys.clear();
  }

  private async embedThroughActive(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][] | null> {
    if (!this.active) return null;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("嵌入请求已取消");
    }
    const result = await this.active.embedTexts(texts, signal);
    if (
      result === null &&
      this.settings.embedding.kernel === "auto" &&
      this.active === this.native
    ) {
      this.fallbackReason = this.native.status().reason ?? "N-API 推理失败";
      console.warn(
        `[嵌入] N-API 推理失败，切换到 Rust sidecar：${this.fallbackReason}`,
      );
      await this.sidecar.start();
      this.active = this.sidecar;
      this.indexedKeys.clear();
      return this.sidecar.embedTexts(texts, signal);
    }
    return result;
  }

  private upsertIndex(entries: Array<{ id: string; vector: number[] }>): void {
    if (!this.active?.indexUpsert || entries.length === 0) return;
    this.active.indexUpsert(entries);
    for (const entry of entries) this.indexedKeys.add(entry.id);
  }
}
