import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface McpServerSettings {
  id: string;
  enabled: boolean;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  tool_allowlist: string[];
}

export interface Settings {
  schema_version: number;
  app: {
    name: string;
    version: string;
    env: string;
  };
  server: {
    host: string;
    port: number;
    ws_path: string;
    cors_origins: string[];
    shutdown_timeout_s: number;
    ws_notify_delay_s: number;
  };
  logging: { level: string };
  paths: {
    data_dir: string;
    embed_model_dir: string | null;
    sqlite_path: string;
    log_dir: string;
    log_file: string;
    chroma_dir: string;
    documents_dir: string;
  };
  database: { timeout_s: number };
  contracts: { ws_event_version: number };
  features: {
    tools: boolean;
    mcp: boolean;
    vision: boolean;
    memory: boolean;
    rag: boolean;
    tts: boolean;
  };
  model: {
    adapter: string;
    provider: string;
    base_url: string;
    api_key: string;
    model: string;
    timeout_s: number;
    connect_timeout_s: number;
    max_retries: number;
    retry_base_delay_s: number;
    max_tokens: number;
    temperature: number;
  };
  persona: { file: string };
  agent: {
    history_turns: number;
    summary_trigger_tokens: number;
    summary_keep_recent_turns: number;
    max_tool_steps: number;
    recursion_limit: number;
    run_timeout_s: number;
    default_session_id: string;
    kernel: "typescript" | "rust";
    rust_command: string;
    rust_args: string[];
  };
  cost: {
    currency: string;
    budget: number;
    warn_ratio: number;
    prices: Record<string, { input_per_1k: number; output_per_1k: number }>;
  };
  embedding: {
    device: string;
    batch_size: number;
    normalize: boolean;
    kernel: "auto" | "napi" | "sidecar";
    napi_addon: string;
    rust_command: string;
  };
  memory: {
    extract_per_turn: boolean;
    top_k: number;
    min_importance: number;
    time_decay_days: number;
    conflict_policy: "persona_first" | "newest_first";
    candidate_limit: number;
  };
  tools: { allowed_dirs: string[] };
  mcp: {
    connect_timeout_s: number;
    call_timeout_s: number;
    max_tools: number;
    max_result_chars: number;
    servers: McpServerSettings[];
  };
  vision: {
    base_url: string;
    model: string;
    timeout_s: number;
    capture_timeout_s: number;
    max_image_bytes: number;
    num_ctx: number;
    num_predict: number;
    keep_alive: string;
  };
  permission: {
    default: "allow" | "confirm" | "deny";
    overrides: Record<string, "allow" | "confirm" | "deny">;
    confirm_timeout_s: number;
  };
  rag: {
    top_k: number;
    min_similarity: number;
    chunk_size: number;
    chunk_overlap: number;
    max_chunks_per_doc: number;
    worldbook_top_k: number;
    worldbook_keyword_boost: number;
    candidate_limit: number;
  };
  tts: {
    provider: string;
    voice: string;
    rate: string;
    volume: string;
    sentence_min_len: number;
    sentence_max_len: number;
    max_chars_per_turn: number;
    base_url: string;
    ref_audio: string;
    prompt_text: string;
    timeout_s: number;
    engine_dir: string;
    temperature: number;
    top_k: number;
    top_p: number;
    ref_audio_dir: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(
  base: T,
  override: DeepPartial<T> | Record<string, unknown>,
): T {
  if (!isObject(base) || !isObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = out[key];
    out[key] =
      isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function envOverrides(): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SOUL_MATE_") || value === undefined) {
      continue;
    }
    const path = key.slice("SOUL_MATE_".length).toLowerCase().split("__");
    let node = root;
    for (const part of path.slice(0, -1)) {
      const next = node[part];
      if (!isObject(next)) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    node[path.at(-1) ?? ""] = parseScalar(value);
  }
  return root;
}

function readYaml(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) {
    return {};
  }
  const value: unknown = parseYaml(fs.readFileSync(file, "utf-8"));
  if (value == null) {
    return {};
  }
  if (!isObject(value)) {
    throw new Error(`配置文件顶层必须是键值映射：${file}`);
  }
  return value;
}

function normalizeMcpServers(value: unknown): McpServerSettings[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const env = isObject(item.env)
      ? Object.fromEntries(
          Object.entries(item.env).map(([key, entry]) => [key, String(entry)]),
        )
      : {};
    return [
      {
        id: String(item.id ?? "").trim(),
        enabled: item.enabled === true,
        transport: String(item.transport ?? "stdio"),
        command: String(item.command ?? "").trim(),
        args: Array.isArray(item.args) ? item.args.map(String) : [],
        env,
        cwd:
          typeof item.cwd === "string" && item.cwd.trim()
            ? resolveBackendPath(item.cwd)
            : null,
        tool_allowlist: Array.isArray(item.tool_allowlist)
          ? item.tool_allowlist.map(String)
          : [],
      },
    ];
  });
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * During tsx/dev this file is under src/config; in the bundled server it lives
 * in dist. Find the package root by looking for config.default.yaml.
 */
export function backendRoot(): string {
  let current = moduleDir();
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(current, "config.default.yaml"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(process.cwd(), "apps/backend");
}

export function resolveBackendPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(backendRoot(), value);
}

export function loadSettings(): Settings {
  const root = backendRoot();
  const defaults = readYaml(path.join(root, "config.default.yaml"));
  const local = readYaml(path.join(root, "config.local.yaml"));
  const overrides = readYaml(path.join(root, "config.overrides.yaml"));
  const merged = deepMerge(
    deepMerge(deepMerge(defaults, local), overrides),
    envOverrides(),
  ) as unknown as Settings;

  const dataDir = resolveBackendPath(
    String(merged.paths?.data_dir ?? "./data"),
  );
  const embedModelDir =
    merged.paths?.embed_model_dir == null
      ? null
      : resolveBackendPath(String(merged.paths.embed_model_dir));
  merged.paths = {
    ...merged.paths,
    data_dir: dataDir,
    embed_model_dir: embedModelDir,
    sqlite_path: path.join(dataDir, "soul_mate.db"),
    log_dir: path.join(dataDir, "logs"),
    log_file: path.join(dataDir, "logs", "backend.log"),
    chroma_dir: path.join(dataDir, "chroma"),
    documents_dir: path.join(dataDir, "documents"),
  };
  merged.persona.file = resolveBackendPath(merged.persona.file);
  if (merged.embedding.rust_command) {
    merged.embedding.rust_command = resolveBackendPath(
      merged.embedding.rust_command,
    );
  }
  if (merged.embedding.napi_addon) {
    merged.embedding.napi_addon = resolveBackendPath(
      merged.embedding.napi_addon,
    );
  }
  if (merged.agent.rust_command) {
    merged.agent.rust_command = resolveBackendPath(merged.agent.rust_command);
  }
  merged.mcp.servers = normalizeMcpServers(merged.mcp.servers);

  if (!Number.isInteger(merged.server.port) || merged.server.port <= 0) {
    throw new Error("server.port 必须是正整数");
  }
  if (!["typescript", "rust"].includes(merged.agent.kernel)) {
    throw new Error("agent.kernel 只能是 typescript 或 rust");
  }
  if (!["auto", "napi", "sidecar"].includes(merged.embedding.kernel)) {
    throw new Error("embedding.kernel 只能是 auto、napi 或 sidecar");
  }
  if (merged.memory.candidate_limit < 1) {
    throw new Error("memory.candidate_limit 必须是正整数");
  }
  if (merged.rag.candidate_limit < 1) {
    throw new Error("rag.candidate_limit 必须是正整数");
  }
  return merged;
}

export function dataPaths(settings: Settings): void {
  for (const dir of [
    settings.paths.data_dir,
    settings.paths.log_dir,
    settings.paths.documents_dir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
