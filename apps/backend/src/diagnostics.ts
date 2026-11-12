import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Runtime } from "./runtime.js";
import { backendRoot, type Settings } from "./config/settings.js";

export type ModuleState =
  "ready" | "degraded" | "disabled" | "missing" | "error";

export interface ModuleStatus {
  id: string;
  label: string;
  enabled: boolean;
  state: ModuleState;
  message: string;
  details: Record<string, unknown>;
}

function fileSize(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function countModelFiles(directory: string): {
  count: number;
  totalBytes: number;
} {
  if (!fs.existsSync(directory)) return { count: 0, totalBytes: 0 };
  let count = 0;
  let totalBytes = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
      } else if (/\.(?:pth|ckpt|bin|safetensors|onnx)$/i.test(entry.name)) {
        count += 1;
        totalBytes += fileSize(file) ?? 0;
      }
    }
  }
  return { count, totalBytes };
}

function embeddingStatus(runtime: Runtime): ModuleStatus {
  const settings = runtime.settings;
  const embedding = runtime.embedding.status();
  const enabled = settings.features.memory || settings.features.rag;
  const modelDir = settings.paths.embed_model_dir;
  const kernelLabel =
    embedding.kernel === "napi" ? "Rust N-API" : "Rust sidecar";
  const details: Record<string, unknown> = {
    retrieval: "sqlite_lexical+rust_vector",
    vector_loader: `rust_${embedding.kernel}`,
    configured_kernel: embedding.configuredKernel,
    active_kernel: embedding.kernel,
    model_dir: modelDir,
    embedding,
  };

  if (!enabled) {
    return {
      id: "embedding",
      label: "向量嵌入",
      enabled: false,
      state: "disabled",
      message: "记忆与 RAG 均未启用，未加载向量嵌入模型",
      details,
    };
  }

  if (!modelDir) {
    return {
      id: "embedding",
      label: "向量嵌入",
      enabled: true,
      state: "degraded",
      message: embedding.available
        ? "未配置向量嵌入模型目录，当前使用 SQLite 词项检索"
        : "未配置向量嵌入模型目录，且未找到 Rust 嵌入内核",
      details: { ...details, model_state: "not_configured" },
    };
  }

  if (!fs.existsSync(modelDir)) {
    return {
      id: "embedding",
      label: "向量嵌入",
      enabled: true,
      state: "missing",
      message: `向量嵌入模型目录不存在：${modelDir}；已回退 SQLite 词项检索`,
      details: { ...details, model_state: "missing" },
    };
  }

  if (embedding.loaded) {
    return {
      id: "embedding",
      label: "向量嵌入",
      enabled: true,
      state: "ready",
      message:
        `${kernelLabel} 嵌入模型已加载（${embedding.dimension ?? "未知"} 维）：` +
        modelDir,
      details: {
        ...details,
        model_state: "loaded",
        dimension: embedding.dimension,
        fallback_reason: embedding.fallbackReason ?? null,
      },
    };
  }

  const required = ["config.json", "model.safetensors"].map((name) =>
    path.join(modelDir, name),
  );
  const missingFiles = required.filter((file) => !fs.existsSync(file));
  if (missingFiles.length > 0) {
    return {
      id: "embedding",
      label: "向量嵌入",
      enabled: true,
      state: "missing",
      message: `向量嵌入模型文件不完整：${missingFiles
        .map((file) => path.basename(file))
        .join("、")}；已回退 SQLite 词项检索`,
      details: {
        ...details,
        model_state: "incomplete",
        missing_files: missingFiles,
      },
    };
  }

  const bytes = fileSize(required[1]!) ?? 0;
  return {
    id: "embedding",
    label: "向量嵌入",
    enabled: true,
    state: "degraded",
    message: embedding.available
      ? `已找到嵌入模型（${(bytes / 1024 / 1024).toFixed(1)} MB），Rust 嵌入内核尚未加载`
      : `已找到嵌入模型（${(bytes / 1024 / 1024).toFixed(1)} MB），但未找到可用的 Rust 嵌入内核；回退词项检索`,
    details: {
      ...details,
      model_state: embedding.available ? "found_not_loaded" : "kernel_missing",
      model_size_bytes: bytes,
    },
  };
}

async function probeTts(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/openapi.json`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      paths?: Record<string, unknown>;
    };
    return Boolean(body.paths && "/tts" in body.paths);
  } catch {
    return false;
  }
}

async function ttsStatus(settings: Settings): Promise<ModuleStatus> {
  const { tts } = settings;
  if (!settings.features.tts) {
    return {
      id: "tts",
      label: "语音合成",
      enabled: false,
      state: "disabled",
      message: "语音合成未启用",
      details: { provider: tts.provider },
    };
  }

  if (tts.provider !== "gpt_sovits") {
    return {
      id: "tts",
      label: "语音合成",
      enabled: true,
      state: "degraded",
      message: `${tts.provider} 提供方尚未在当前 TypeScript 版本中实现`,
      details: { provider: tts.provider },
    };
  }

  const missing: string[] = [];
  if (!tts.base_url.trim()) missing.push("base_url");
  if (!tts.ref_audio.trim()) missing.push("ref_audio");
  if (!tts.prompt_text.trim()) missing.push("prompt_text");
  if (missing.length > 0) {
    return {
      id: "tts",
      label: "语音合成",
      enabled: true,
      state: "missing",
      message: `GPT-SoVITS 配置缺少：${missing.join("、")}`,
      details: { provider: tts.provider, missing },
    };
  }

  if (!fs.existsSync(tts.ref_audio)) {
    return {
      id: "tts",
      label: "语音合成",
      enabled: true,
      state: "missing",
      message: `GPT-SoVITS 参考音频不存在：${tts.ref_audio}`,
      details: { provider: tts.provider, ref_audio: tts.ref_audio },
    };
  }

  const engineRoot = tts.engine_dir.trim();
  const weights = engineRoot
    ? countModelFiles(path.join(engineRoot, "GPT_SoVITS", "pretrained_models"))
    : { count: 0, totalBytes: 0 };
  const serviceReady = await probeTts(tts.base_url);
  const details: Record<string, unknown> = {
    provider: tts.provider,
    base_url: tts.base_url,
    ref_audio: tts.ref_audio,
    engine_dir: engineRoot || null,
    model_files: weights.count,
    model_bytes: weights.totalBytes,
    service_reachable: serviceReady,
  };

  if (serviceReady) {
    return {
      id: "tts",
      label: "语音合成",
      enabled: true,
      state: "ready",
      message: `GPT-SoVITS 服务已连接：${tts.base_url}`,
      details,
    };
  }

  return {
    id: "tts",
    label: "语音合成",
    enabled: true,
    state: "degraded",
    message:
      `GPT-SoVITS 配置完整${weights.count > 0 ? `，已找到 ${weights.count} 个模型文件` : ""}，` +
      `但启动时未探测到服务：${tts.base_url}`,
    details,
  };
}

function assetHints(): ModuleStatus {
  const desktopPublic = path.resolve(backendRoot(), "..", "desktop", "public");
  const candidates = [
    path.join(desktopPublic, "model", "character", "xiadie.vrm"),
    path.resolve(
      backendRoot(),
      "..",
      "renderer",
      "model",
      "character",
      "xiadie.vrm",
    ),
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (found) {
    return {
      id: "character_3d",
      label: "3D 角色资源",
      enabled: true,
      state: "ready",
      message: `已找到 VRM 模型：${found}`,
      details: { path: found, size_bytes: fileSize(found) ?? 0 },
    };
  }
  return {
    id: "character_3d",
    label: "3D 角色资源",
    enabled: true,
    state: "degraded",
    message: "后端无法直接检查打包内 VRM；前端加载后会输出模型材质与贴图日志",
    details: {},
  };
}

export async function inspectRuntimeModules(
  runtime: Runtime,
): Promise<ModuleStatus[]> {
  const settings = runtime.settings;
  const database = runtime.database.health();
  const mcp = runtime.mcp.status();
  const statuses: ModuleStatus[] = [
    {
      id: "database",
      label: "数据库",
      enabled: true,
      state: database.status === "ok" ? "ready" : "error",
      message:
        database.status === "ok"
          ? `SQLite 已就绪：${settings.paths.sqlite_path}`
          : `SQLite 异常：${String(database.error ?? "未知错误")}`,
      details: database,
    },
    {
      id: "model",
      label: "对话模型",
      enabled: true,
      state: settings.model.api_key ? "ready" : "degraded",
      message: settings.model.api_key
        ? `模型已配置：${settings.model.provider}/${settings.model.model}`
        : "未配置 API 密钥，聊天模型请求会失败",
      details: {
        provider: settings.model.provider,
        model: settings.model.model,
        base_url: settings.model.base_url,
        api_key_set: Boolean(settings.model.api_key),
      },
    },
    {
      id: "agent",
      label: "Agent 内核",
      enabled: true,
      state: "ready",
      message:
        runtime.kernel.id === "rust-sidecar"
          ? `Rust Agent sidecar 已启用（契约版本 ${runtime.kernel.contractVersion}）`
          : `TypeScript Agent 已加载（契约版本 ${runtime.kernel.contractVersion}）`,
      details: {
        kernel: runtime.kernel.id,
        contract_version: runtime.kernel.contractVersion,
      },
    },
    {
      id: "tools",
      label: "工具",
      enabled: settings.features.tools,
      state: settings.features.tools ? "ready" : "disabled",
      message: settings.features.tools
        ? `工具已启用，允许目录数：${settings.tools.allowed_dirs.length}`
        : "工具调用未启用",
      details: { allowed_dirs: settings.tools.allowed_dirs.length },
    },
    {
      id: "mcp",
      label: "MCP 工具网关",
      enabled: mcp.enabled,
      state: mcp.enabled
        ? mcp.servers.some((server) => !server.connected)
          ? "degraded"
          : "ready"
        : "disabled",
      message: mcp.enabled
        ? `MCP 服务 ${mcp.servers.filter((server) => server.connected).length}/${mcp.servers.length} 已连接，工具数：${mcp.toolCount}`
        : "MCP 工具服务未启用",
      details: { ...mcp },
    },
    embeddingStatus(runtime),
    await ttsStatus(settings),
    {
      id: "vision",
      label: "视觉",
      enabled: settings.features.vision,
      state: settings.features.vision ? "ready" : "disabled",
      message: settings.features.vision
        ? `视觉配置已加载：${settings.vision.model} @ ${settings.vision.base_url}`
        : "视觉能力未启用",
      details: {
        model: settings.vision.model,
        base_url: settings.vision.base_url,
      },
    },
    assetHints(),
  ];
  return statuses;
}

export function logModuleStatuses(
  logger: FastifyBaseLogger,
  statuses: ModuleStatus[],
): void {
  logger.info("关键模块状态：");
  for (const status of statuses) {
    const line = `[模块] ${status.label}：${status.message}`;
    if (status.state === "error") {
      logger.error(line);
    } else if (status.state === "missing" || status.state === "degraded") {
      logger.warn(line);
    } else {
      logger.info(line);
    }
  }
}
