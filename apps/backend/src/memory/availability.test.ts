import { describe, expect, it } from "vitest";
import { loadSettings } from "../config/settings.js";
import { memoryRetrievalUnavailableReason } from "./availability.js";
import type { EmbeddingStatus } from "./embedding-types.js";

function status(overrides: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
  return {
    enabled: false,
    available: false,
    loaded: false,
    kernel: "napi",
    configuredKernel: "auto",
    command: null,
    addonPath: null,
    modelDir: null,
    dimension: null,
    reason: "未配置本地嵌入模型",
    ...overrides,
  };
}

describe("memory retrieval availability", () => {
  it("stays quiet when memory and RAG are disabled", () => {
    const settings = loadSettings();
    settings.features.memory = false;
    settings.features.rag = false;
    expect(memoryRetrievalUnavailableReason(settings, status())).toBeNull();
  });

  it("reports why semantic retrieval is unavailable", () => {
    const settings = loadSettings();
    settings.features.memory = true;
    expect(memoryRetrievalUnavailableReason(settings, status())).toBe(
      "未配置本地嵌入模型",
    );
  });

  it("accepts a loaded embedding kernel", () => {
    const settings = loadSettings();
    settings.features.rag = true;
    expect(
      memoryRetrievalUnavailableReason(
        settings,
        status({ enabled: true, available: true, loaded: true }),
      ),
    ).toBeNull();
  });
});
