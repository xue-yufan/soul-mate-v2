import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../config/settings.js";
import { EmbeddingService } from "./embedding-service.js";
import type { EmbeddingClient, EmbeddingStatus } from "./embedding-types.js";

function status(kernel: "napi" | "sidecar"): EmbeddingStatus {
  return {
    enabled: true,
    available: true,
    loaded: true,
    kernel,
    configuredKernel: "auto",
    command: null,
    addonPath: null,
    modelDir: "model",
    dimension: 3,
    reason: null,
    metrics: {
      state: "ready",
      activeRequests: 0,
      queuedRequests: 0,
      registeredRequests: 0,
      completedRequests: 1,
      cancelledRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      cacheHits: 0,
      cacheMisses: 1,
      indexEntries: 0,
      averageInferenceMs: 1,
      lastInferenceMs: 1,
      loadMs: 1,
      workerLimit: 2,
      queueLimit: 8,
    },
  };
}

function client(
  kernel: "napi" | "sidecar",
  start: () => Promise<void>,
): EmbeddingClient {
  return {
    enabled: true,
    start,
    status: () => status(kernel),
    embedTexts: vi.fn(async (texts: readonly string[]) =>
      texts.map(() => [1, 0, 0]),
    ),
    semanticScores: vi.fn(async () => [1]),
    close: vi.fn(async () => undefined),
  };
}

describe("EmbeddingService", () => {
  it("N-API 加载失败时自动回退 sidecar", async () => {
    const native = client("napi", async () => {
      throw new Error("addon unavailable");
    });
    const sidecar = client("sidecar", async () => undefined);
    const service = new EmbeddingService(
      { embedding: { kernel: "auto" } } as Settings,
      { native, sidecar },
    );

    await expect(service.start()).resolves.toBeUndefined();
    expect(service.status().kernel).toBe("sidecar");
    expect(service.status().fallbackReason).toBe("addon unavailable");
    await expect(service.embedTexts(["hello"])).resolves.toEqual([[1, 0, 0]]);
    expect(sidecar.embedTexts).toHaveBeenCalledOnce();
  });
});
