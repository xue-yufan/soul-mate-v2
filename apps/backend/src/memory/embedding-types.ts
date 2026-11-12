export type EmbeddingKernelKind = "napi" | "sidecar";

export interface EmbeddingMetrics {
  state: string;
  activeRequests: number;
  queuedRequests: number;
  registeredRequests: number;
  completedRequests: number;
  cancelledRequests: number;
  failedRequests: number;
  rejectedRequests: number;
  cacheHits: number;
  cacheMisses: number;
  indexEntries: number;
  averageInferenceMs: number;
  lastInferenceMs: number;
  loadMs: number;
  workerLimit: number;
  queueLimit: number;
}

export interface EmbeddingStatus {
  enabled: boolean;
  available: boolean;
  loaded: boolean;
  kernel: EmbeddingKernelKind;
  configuredKernel: "auto" | EmbeddingKernelKind;
  command: string | null;
  addonPath: string | null;
  modelDir: string | null;
  dimension: number | null;
  reason: string | null;
  fallbackReason?: string;
  persistentCacheHits?: number;
  persistentCacheMisses?: number;
  persistentCacheEntries?: number;
  metrics?: EmbeddingMetrics;
}

export interface RankingCandidate {
  id: string;
  text: string;
}

export interface EmbeddingClient {
  readonly enabled: boolean;
  status(): EmbeddingStatus;
  start(): Promise<void>;
  embedTexts(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][] | null>;
  semanticScores(
    query: string,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[] | null>;
  indexUpsert?(entries: Array<{ id: string; vector: number[] }>): void;
  indexRemove?(ids: string[]): void;
  rankVector?(
    query: number[],
    ids: string[],
    limit: number,
  ): Array<{ id: string; score: number }>;
  rankCandidates?(
    query: string,
    candidates: readonly RankingCandidate[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<Map<string, number> | null>;
  close(): Promise<void>;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("嵌入请求已取消");
}

export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

export async function semanticScoresFromVectors(
  vectors: readonly (readonly number[])[] | null,
  textCount: number,
): Promise<number[] | null> {
  if (!vectors || vectors.length !== textCount + 1) return null;
  const queryVector = vectors[0] ?? [];
  return vectors
    .slice(1)
    .map((vector) => Math.max(0, cosineSimilarity(queryVector, vector)));
}
