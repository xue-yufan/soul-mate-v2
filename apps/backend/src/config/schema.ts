import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Settings } from "./settings.js";
import { backendRoot } from "./settings.js";

export type FieldKind =
  "bool" | "int" | "float" | "str" | "select" | "secret" | "lines";

export interface FieldSpec {
  path: string;
  label: string;
  group: string;
  kind: FieldKind;
  help?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  optionLabels?: Record<string, string>;
}

export class ConfigValueError extends Error {}

const GROUPS = [
  {
    id: "voice",
    title: "语音",
    description: "控制后端要不要合成语音。",
  },
  { id: "model", title: "模型", description: "用哪个模型，以及怎么连上它。" },
  { id: "memory", title: "记忆", description: "长期记忆与资料检索。" },
  { id: "tools", title: "工具", description: "工具权限与执行边界。" },
  { id: "vision", title: "视觉", description: "本机视觉观察。" },
  { id: "agent", title: "对话", description: "历史与上下文压缩。" },
];

const fields = (...items: FieldSpec[]): FieldSpec[] => items;

export const FIELD_SPECS = fields(
  {
    path: "features.tts",
    label: "启用语音合成",
    group: "voice",
    kind: "bool",
  },
  {
    path: "tts.provider",
    label: "语音引擎",
    group: "voice",
    kind: "select",
    options: ["edge", "gpt_sovits"],
    optionLabels: {
      edge: "Edge（TypeScript 版暂未内置）",
      gpt_sovits: "GPT-SoVITS（本地 HTTP）",
    },
  },
  { path: "tts.base_url", label: "本地引擎地址", group: "voice", kind: "str" },
  { path: "tts.voice", label: "音色", group: "voice", kind: "str" },
  { path: "tts.rate", label: "语速", group: "voice", kind: "str" },
  { path: "tts.volume", label: "合成音量", group: "voice", kind: "str" },
  {
    path: "tts.timeout_s",
    label: "单句合成超时",
    group: "voice",
    kind: "float",
    unit: "秒",
    min: 1,
    max: 600,
    step: 5,
  },
  {
    path: "tts.max_chars_per_turn",
    label: "单轮字数上限",
    group: "voice",
    kind: "int",
    unit: "字",
    min: 0,
    max: 100000,
    step: 100,
  },
  { path: "tts.ref_audio", label: "参考音频", group: "voice", kind: "str" },
  {
    path: "tts.prompt_text",
    label: "参考音频文本",
    group: "voice",
    kind: "str",
  },
  {
    path: "tts.engine_dir",
    label: "本地引擎目录",
    group: "voice",
    kind: "str",
  },
  {
    path: "tts.temperature",
    label: "声音起伏",
    group: "voice",
    kind: "float",
    min: 0.1,
    max: 2,
    step: 0.05,
  },
  {
    path: "tts.top_k",
    label: "采样 top-k",
    group: "voice",
    kind: "int",
    min: 1,
    max: 100,
  },
  {
    path: "tts.top_p",
    label: "采样 top-p",
    group: "voice",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "tts.ref_audio_dir",
    label: "情绪参考音频目录",
    group: "voice",
    kind: "str",
  },
  { path: "model.model", label: "模型名", group: "model", kind: "str" },
  { path: "model.base_url", label: "接口地址", group: "model", kind: "str" },
  {
    path: "model.temperature",
    label: "回答随机性",
    group: "model",
    kind: "float",
    min: 0,
    max: 2,
    step: 0.1,
  },
  {
    path: "model.max_tokens",
    label: "单次回答长度上限",
    group: "model",
    kind: "int",
    min: 1,
    max: 65536,
    step: 128,
  },
  {
    path: "model.timeout_s",
    label: "请求超时",
    group: "model",
    kind: "int",
    unit: "秒",
    min: 1,
    max: 600,
    step: 5,
  },
  {
    path: "model.api_key",
    label: "API 密钥",
    group: "model",
    kind: "secret",
  },
  {
    path: "cost.currency",
    label: "金额单位",
    group: "model",
    kind: "select",
    options: ["CNY", "USD"],
    optionLabels: { CNY: "人民币（CNY）", USD: "美元（USD）" },
  },
  {
    path: "features.memory",
    label: "长期记忆",
    group: "memory",
    kind: "bool",
  },
  {
    path: "memory.extract_per_turn",
    label: "每轮自动整理记忆",
    group: "memory",
    kind: "bool",
  },
  {
    path: "memory.top_k",
    label: "每次回忆几条",
    group: "memory",
    kind: "int",
    min: 1,
    max: 50,
  },
  {
    path: "memory.candidate_limit",
    label: "记忆候选上限",
    group: "memory",
    kind: "int",
    unit: "条",
    min: 64,
    max: 2000,
    step: 64,
  },
  {
    path: "memory.min_importance",
    label: "值得记住的最低门槛",
    group: "memory",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "memory.time_decay_days",
    label: "记忆淡忘周期",
    group: "memory",
    kind: "int",
    unit: "天",
    min: 1,
    max: 3650,
  },
  {
    path: "memory.conflict_policy",
    label: "记忆冲突时",
    group: "memory",
    kind: "select",
    options: ["persona_first", "newest_first"],
    optionLabels: {
      persona_first: "以人格设定为准",
      newest_first: "以最新说法为准",
    },
  },
  {
    path: "features.rag",
    label: "资料库检索",
    group: "memory",
    kind: "bool",
  },
  {
    path: "rag.top_k",
    label: "每次引用几段文档",
    group: "memory",
    kind: "int",
    min: 1,
    max: 50,
  },
  {
    path: "rag.candidate_limit",
    label: "RAG 候选上限",
    group: "memory",
    kind: "int",
    unit: "条",
    min: 64,
    max: 4000,
    step: 128,
  },
  {
    path: "rag.min_similarity",
    label: "引用门槛",
    group: "memory",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "rag.chunk_size",
    label: "文档切块长度",
    group: "memory",
    kind: "int",
    unit: "字",
    min: 100,
    max: 4000,
    step: 50,
  },
  {
    path: "rag.chunk_overlap",
    label: "相邻切块重叠",
    group: "memory",
    kind: "int",
    unit: "字",
    min: 0,
    max: 1000,
    step: 10,
  },
  {
    path: "rag.worldbook_top_k",
    label: "每次引用几条世界书",
    group: "memory",
    kind: "int",
    min: 0,
    max: 20,
  },
  {
    path: "features.tools",
    label: "工具调用",
    group: "tools",
    kind: "bool",
  },
  {
    path: "features.mcp",
    label: "外部工具服务",
    group: "tools",
    kind: "bool",
    help: "允许连接已配置的 Windows stdio MCP 服务；每次工具调用仍需权限确认。",
  },
  {
    path: "features.vision",
    label: "允许自主看一眼",
    group: "vision",
    kind: "bool",
  },
  { path: "vision.model", label: "视觉模型", group: "vision", kind: "str" },
  {
    path: "vision.base_url",
    label: "本机视觉服务",
    group: "vision",
    kind: "str",
  },
  {
    path: "vision.timeout_s",
    label: "观察超时",
    group: "vision",
    kind: "float",
    unit: "秒",
    min: 5,
    max: 600,
    step: 5,
  },
  {
    path: "vision.capture_timeout_s",
    label: "等待抓帧",
    group: "vision",
    kind: "float",
    unit: "秒",
    min: 3,
    max: 120,
  },
  {
    path: "vision.max_image_bytes",
    label: "单帧大小上限",
    group: "vision",
    kind: "int",
    unit: "字节",
    min: 100000,
    max: 10000000,
    step: 100000,
  },
  {
    path: "vision.num_ctx",
    label: "视觉上下文",
    group: "vision",
    kind: "int",
    min: 1024,
    max: 32768,
    step: 1024,
  },
  {
    path: "vision.num_predict",
    label: "观察输出上限",
    group: "vision",
    kind: "int",
    min: 64,
    max: 2048,
    step: 64,
  },
  {
    path: "vision.keep_alive",
    label: "模型闲置保留",
    group: "vision",
    kind: "str",
  },
  {
    path: "tools.allowed_dirs",
    label: "允许她读取的目录",
    group: "tools",
    kind: "lines",
  },
  {
    path: "permission.default",
    label: "默认权限",
    group: "tools",
    kind: "select",
    options: ["allow", "confirm", "deny"],
    optionLabels: {
      allow: "直接执行",
      confirm: "每次询问",
      deny: "一律拒绝",
    },
  },
  {
    path: "permission.confirm_timeout_s",
    label: "确认超时",
    group: "tools",
    kind: "float",
    unit: "秒",
    min: 5,
    max: 600,
    step: 5,
  },
  {
    path: "agent.max_tool_steps",
    label: "单轮最多用几次工具",
    group: "tools",
    kind: "int",
    unit: "次",
    min: 1,
    max: 20,
  },
  {
    path: "agent.history_turns",
    label: "每轮带几段历史",
    group: "agent",
    kind: "int",
    unit: "轮",
    min: 0,
    max: 50,
  },
);

const byPath = new Map(FIELD_SPECS.map((spec) => [spec.path, spec]));

export const RESTART_REQUIRED_PATHS = new Set([
  "features.tools",
  "features.mcp",
  "features.vision",
  "features.memory",
  "features.rag",
  "features.tts",
  "paths.embed_model_dir",
  "tts.provider",
  "tts.voice",
  "tts.base_url",
  "tts.ref_audio",
  "tts.prompt_text",
  "tts.engine_dir",
  "tts.temperature",
  "tts.top_k",
  "tts.top_p",
  "tts.ref_audio_dir",
  "tts.timeout_s",
  "tts.rate",
  "tts.volume",
]);

export function overridesPath(): string {
  return path.join(backendRoot(), "config.overrides.yaml");
}

export function envNameForPath(dotted: string): string {
  return `SOUL_MATE_${dotted.replaceAll(".", "__").toUpperCase()}`;
}

export function envLock(dotted: string): string | null {
  const wanted = envNameForPath(dotted).toUpperCase();
  return (
    Object.keys(process.env).find((key) => key.toUpperCase() === wanted) ?? null
  );
}

function getAtPath(settings: Settings, dotted: string): unknown {
  let node: unknown = settings;
  for (const part of dotted.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function coerce(spec: FieldSpec, raw: unknown): unknown {
  if (spec.kind === "bool") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string" && /^(true|false)$/i.test(raw.trim())) {
      return raw.trim().toLowerCase() === "true";
    }
    throw new ConfigValueError(`${spec.label} 只能是「开」或「关」`);
  }
  if (spec.kind === "int" || spec.kind === "float") {
    if (typeof raw === "boolean" || raw === "") {
      throw new ConfigValueError(`${spec.label} 需要填数字`);
    }
    const number =
      spec.kind === "int" ? Number.parseInt(String(raw), 10) : Number(raw);
    if (!Number.isFinite(number)) {
      throw new ConfigValueError(
        `${spec.label} 需要${spec.kind === "int" ? "整数" : "数字"}`,
      );
    }
    if (spec.min !== undefined && number < spec.min) {
      throw new ConfigValueError(`${spec.label} 不能小于 ${spec.min}`);
    }
    if (spec.max !== undefined && number > spec.max) {
      throw new ConfigValueError(`${spec.label} 不能大于 ${spec.max}`);
    }
    return number;
  }
  if (spec.kind === "select") {
    const value = String(raw).trim();
    if (!(spec.options ?? []).includes(value)) {
      throw new ConfigValueError(`${spec.label} 的选项无效`);
    }
    return value;
  }
  if (spec.kind === "lines") {
    const values = Array.isArray(raw)
      ? raw.map(String)
      : String(raw).split(/\r?\n/);
    return values.map((item) => item.trim()).filter(Boolean);
  }
  const value = String(raw).trim();
  if (!value) throw new ConfigValueError(`${spec.label} 不能为空`);
  return value;
}

function setNested(
  target: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

function deleteNested(target: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(".");
  const chain: Array<{ node: Record<string, unknown>; key: string }> = [];
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const child = node[part];
    if (typeof child !== "object" || child === null) return;
    chain.push({ node, key: part });
    node = child as Record<string, unknown>;
  }
  delete node[parts.at(-1)!];
  for (const item of chain.reverse()) {
    const child = item.node[item.key];
    if (
      typeof child === "object" &&
      child !== null &&
      Object.keys(child).length === 0
    ) {
      delete item.node[item.key];
    } else {
      break;
    }
  }
}

function readOverrides(): Record<string, unknown> {
  const file = overridesPath();
  if (!fs.existsSync(file)) return {};
  const value: unknown = parseYaml(fs.readFileSync(file, "utf-8"));
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigValueError("配置文件顶层必须是键值映射");
  }
  return value as Record<string, unknown>;
}

function writeOverrides(data: Record<string, unknown>): void {
  const file = overridesPath();
  if (Object.keys(data).length === 0) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  const header =
    "# Written by the settings panel. Manual edits will be overwritten.\n" +
    "# config.local.yaml remains the place for long-lived local configuration.\n";
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, header + stringifyYaml(data), "utf-8");
  fs.renameSync(temporary, file);
}

export function applyConfigPatch(
  values: Record<string, unknown>,
  reset: string[],
): Record<string, unknown> {
  if (Object.keys(values).length === 0 && reset.length === 0) {
    throw new ConfigValueError("没有需要修改的字段");
  }
  const unknown = [...Object.keys(values), ...reset].filter(
    (dotted) => !byPath.has(dotted),
  );
  if (unknown.length > 0) {
    throw new ConfigValueError(`不支持的配置项：${unknown.join(", ")}`);
  }
  const locked = [...Object.keys(values), ...reset]
    .map((dotted) => [dotted, envLock(dotted)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  if (locked.length > 0) {
    throw new ConfigValueError(
      `以下配置被环境变量固定：${locked
        .map(
          ([dotted, env]) => `${byPath.get(dotted)?.label ?? dotted}（${env}）`,
        )
        .join("；")}`,
    );
  }

  const data = readOverrides();
  const previous = structuredClone(data);
  for (const dotted of reset) deleteNested(data, dotted);
  for (const [dotted, raw] of Object.entries(values)) {
    setNested(data, dotted, coerce(byPath.get(dotted)!, raw));
  }
  writeOverrides(data);
  return previous;
}

export function restoreOverrides(data: Record<string, unknown>): void {
  writeOverrides(data);
}

export function buildSettingsPayload(
  settings: Settings,
): Record<string, unknown> {
  return {
    groups: GROUPS,
    fields: FIELD_SPECS.map((spec) => {
      const isSecret = spec.kind === "secret";
      return {
        path: spec.path,
        label: spec.label,
        group: spec.group,
        kind: spec.kind,
        help: spec.help ?? "",
        unit: spec.unit ?? "",
        min: spec.min ?? null,
        max: spec.max ?? null,
        step: spec.step ?? null,
        options: spec.options ?? [],
        option_labels: spec.optionLabels ?? {},
        value: isSecret ? null : (getAtPath(settings, spec.path) ?? null),
        locked_by: envLock(spec.path),
        ...(isSecret
          ? { is_set: Boolean(getAtPath(settings, spec.path)) }
          : {}),
      };
    }),
    overrides_file: overridesPath(),
    restart_required: true,
  };
}
