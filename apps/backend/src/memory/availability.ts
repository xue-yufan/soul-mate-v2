import type { Settings } from "../config/settings.js";
import type { EmbeddingStatus } from "./embedding-types.js";

export function memoryRetrievalUnavailableReason(
  settings: Settings,
  status: EmbeddingStatus,
): string | null {
  if (!settings.features.memory && !settings.features.rag) return null;
  if (status.available && status.loaded) return null;
  return (
    status.reason ??
    status.fallbackReason ??
    (status.enabled
      ? "本地嵌入内核尚未就绪"
      : "未配置可用的本地嵌入模型")
  );
}
