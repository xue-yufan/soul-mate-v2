import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../config/settings.js";
import { backendRoot } from "../config/settings.js";

const ENGINE_ORDER = ["sherpa", "whisper"] as const;
const MAX_STDOUT_BYTES = 4_000_000;
const MAX_STDERR_CHARS = 24_000;
const MAX_TRANSCRIPT_CHARS = 10_000;

type AsrEngine = (typeof ENGINE_ORDER)[number];

export interface AsrStatus {
  enabled: boolean;
  available: boolean;
  engine: string;
  provider: string;
  command: string | null;
  model: string | null;
  message: string;
}

export interface AsrResult {
  text: string;
  engine: string;
  elapsedMs: number;
}

interface EnginePlan {
  engine: AsrEngine;
  command: string;
  args: string[];
  model: string | null;
  modelDir: string;
}

interface ResolveOptions {
  pathValue?: string;
  platform?: NodeJS.Platform;
}

export class LocalAsr {
  private readonly plan: EnginePlan | null;
  private readonly unavailableReason: string | null;

  constructor(
    private readonly settings: Settings,
    options: ResolveOptions = {},
  ) {
    const resolved = resolveEnginePlan(settings, options);
    this.plan = resolved.plan;
    this.unavailableReason = resolved.reason;
  }

  status(): AsrStatus {
    if (!this.settings.features.voice) {
      return {
        enabled: false,
        available: false,
        engine: this.settings.voice.engine,
        provider: this.settings.voice.provider,
        command: null,
        model: null,
        message: "本地语音输入未启用",
      };
    }
    return {
      enabled: true,
      available: this.plan !== null,
      engine: this.plan?.engine ?? this.settings.voice.engine,
      provider: this.settings.voice.provider,
      command: this.plan?.command ?? null,
      model: this.plan?.model ?? null,
      message:
        this.plan !== null
          ? `${engineLabel(this.plan.engine)} 已就绪（${this.settings.voice.provider}）`
          : (this.unavailableReason ?? "未找到可用的本地语音识别引擎"),
    };
  }

  async transcribe(wav: Buffer, signal?: AbortSignal): Promise<AsrResult> {
    if (!this.settings.features.voice) {
      throw new Error("本地语音输入未启用");
    }
    if (!this.plan) {
      throw new Error(
        this.unavailableReason ?? "未找到可用的本地语音识别引擎",
      );
    }
    validateWav(wav);
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("语音识别已取消");
    }

    const tempRoot =
      this.settings.voice.temp_dir.trim() || this.settings.paths.data_dir;
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, "asr-"),
    );
    const audioPath = path.join(tempDir, "input.wav");
    const outputBase = path.join(tempDir, "transcript");
    fs.writeFileSync(audioPath, wav);
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`语音识别超时（${this.settings.voice.timeout_s} 秒）`));
    }, this.settings.voice.timeout_s * 1000);
    timeout.unref();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const combinedSignal = controller.signal;

    try {
      const args = this.plan.args.map((arg) =>
        fillArgument(arg, {
          audio: audioPath,
          output: outputBase,
          model: this.plan?.model ?? "",
          modelDir: this.plan?.modelDir ?? "",
          model_dir: this.plan?.modelDir ?? "",
          tokens: findModelFile(this.plan?.modelDir ?? "", /^tokens\.txt$/i) ?? "",
          language: this.settings.voice.language,
          threads: String(this.settings.voice.threads),
        }),
      );
      const stdout = await runEngine(
        this.plan.command,
        args,
        this.plan.modelDir || backendRoot(),
        combinedSignal,
      );
      const fileText =
        readOptionalText(`${outputBase}.txt`) ?? readOptionalText(outputBase);
      const text = normalizeTranscript(fileText ?? stdout);
      if (!text) throw new Error("语音引擎没有返回可识别的文本");
      return {
        text,
        engine: engineLabel(this.plan.engine),
        elapsedMs: Math.round(performance.now() - started),
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export function resolveEnginePlan(
  settings: Settings,
  options: ResolveOptions = {},
): { plan: EnginePlan | null; reason: string | null } {
  if (!settings.features.voice) {
    return { plan: null, reason: "本地语音输入未启用" };
  }
  const configured = settings.voice.command.trim();
  const inferred = configured ? inferEngine(configured) : null;
  const order =
    settings.voice.engine === "auto"
      ? inferred
        ? [inferred]
        : [...ENGINE_ORDER]
      : [settings.voice.engine];
  const reasons: string[] = [];

  for (const engine of order) {
    const command = configured
      ? resolveExecutable(configured, options)
      : findCommand(commandCandidates(engine), options);
    if (!command) {
      reasons.push(`${engineLabel(engine)} 可执行文件未找到`);
      continue;
    }
    const built = buildPlan(settings, engine, command);
    if (built.plan) return { plan: built.plan, reason: null };
    reasons.push(built.reason ?? `${engineLabel(engine)} 配置不完整`);
  }
  return { plan: null, reason: reasons.join("；") };
}

function buildPlan(
  settings: Settings,
  engine: AsrEngine,
  command: string,
): { plan: EnginePlan | null; reason: string | null } {
  const modelDir = settings.voice.model_dir.trim();
  const customArgs = settings.voice.args.length > 0;
  if (modelDir && !fs.existsSync(modelDir)) {
    return { plan: null, reason: `语音模型目录不存在：${modelDir}` };
  }
  const model =
    engine === "whisper"
      ? findWhisperModel(modelDir)
      : findSherpaModel(modelDir, settings.voice.provider);
  let args: string[];

  if (customArgs) {
    args = settings.voice.args.map(String);
    if (!args.some((arg) => arg.includes("{audio}"))) args.push("{audio}");
    if (
      engine === "sherpa" &&
      settings.voice.provider !== "cpu" &&
      !args.some((arg) => arg.startsWith("--provider"))
    ) {
      args.unshift(`--provider=${providerName(settings)}`);
    }
  } else if (engine === "whisper") {
    if (!model) {
      return {
        plan: null,
        reason: "whisper.cpp 需要 voice.model_dir 中的 ggml-*.bin 模型，或自定义 voice.args",
      };
    }
    args = [
      "-m",
      "{model}",
      "-f",
      "{audio}",
      "-l",
      "{language}",
      "-nt",
      "-otxt",
      "-of",
      "{output}",
    ];
  } else {
    const tokens = findModelFile(modelDir, /^tokens\.txt$/i);
    if (!model || !tokens) {
      return {
        plan: null,
        reason:
          "sherpa-onnx 自动参数需要 model_dir 中的 SenseVoice ONNX 模型和 tokens.txt，或自定义 voice.args",
      };
    }
    args = [
      `--tokens=${tokens}`,
      `--sense-voice-model=${model}`,
      `--sense-voice-language=${settings.voice.language || "auto"}`,
      "--sense-voice-use-itn=1",
      `--num-threads=${settings.voice.threads}`,
      "--debug=0",
      ...(settings.voice.provider === "cpu"
        ? []
        : [`--provider=${providerName(settings)}`]),
      "{audio}",
    ];
  }

  return {
    plan: {
      engine,
      command,
      args,
      model,
      modelDir: modelDir || path.dirname(command),
    },
    reason: null,
  };
}

function validateWav(wav: Buffer): void {
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("语音输入必须是有效的 WAV 音频");
  }
  const sampleRate = wav.readUInt32LE(24);
  if (sampleRate !== 16_000) {
    throw new Error(`语音输入必须是 16 kHz WAV，当前为 ${sampleRate} Hz`);
  }
}

function runEngine(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("语音识别已取消"));
      return;
    }
    const child = spawn(command, args, {
      cwd: fs.existsSync(cwd) ? cwd : backendRoot(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, output = ""): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(output);
    };
    const stop = (): void => {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出。
      }
    };
    const onAbort = (): void => {
      stop();
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("语音识别已取消"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES) {
        stop();
        finish(new Error("语音引擎输出过大"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        finish(null, stdout);
      } else {
        finish(
          new Error(
            `语音引擎退出码 ${String(code)}${stderr.trim() ? `：${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

function findCommand(
  candidates: readonly string[],
  options: ResolveOptions,
): string | null {
  for (const candidate of candidates) {
    const found = resolveExecutable(candidate, options);
    if (found) return found;
  }
  return null;
}

function resolveExecutable(
  executable: string,
  options: ResolveOptions,
): string | null {
  if (fs.existsSync(executable)) return path.resolve(executable);
  if (executable.includes("/") || executable.includes("\\")) return null;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const extensions =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        `${executable}${extension.toLowerCase()}`,
      );
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(directory, `${executable}${extension.toUpperCase()}`);
      if (upper !== candidate && fs.existsSync(upper)) return upper;
    }
  }
  return null;
}

function commandCandidates(engine: AsrEngine): readonly string[] {
  return engine === "sherpa"
    ? ["sherpa-onnx-offline", "sherpa-onnx"]
    : ["whisper-cli", "whisper-cpp", "whisper"];
}

function inferEngine(command: string): AsrEngine | null {
  const lower = path.basename(command).toLowerCase();
  if (lower.includes("sherpa")) return "sherpa";
  if (lower.includes("whisper")) return "whisper";
  return null;
}

function findWhisperModel(directory: string): string | null {
  return (
    findModelFile(directory, /^ggml.*\.bin$/i) ??
    findModelFile(directory, /\.bin$/i)
  );
}

function findSherpaModel(directory: string, provider: string): string | null {
  if (provider === "openvino") {
    return (
      findModelFile(directory, /^model\.onnx$/i) ??
      findModelFile(directory, /(?:sense[-_]?voice|model).*\.onnx$/i)
    );
  }
  return (
    findModelFile(directory, /^model\.int8\.onnx$/i) ??
    findModelFile(directory, /(?:sense[-_]?voice|model).*\.onnx$/i)
  );
}

function findModelFile(directory: string, pattern: RegExp): string | null {
  if (!directory || !fs.existsSync(directory)) return null;
  const stack = [directory];
  let visited = 0;
  while (stack.length > 0 && visited < 1_000) {
    const current = stack.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (pattern.test(entry.name)) return file;
    }
  }
  return null;
}

function fillArgument(
  argument: string,
  values: Record<string, string>,
): string {
  return argument.replace(/\{([a-z_]+)\}/gi, (match, key: string) =>
    values[key] ?? match,
  );
}

function normalizeTranscript(raw: string): string {
  const lines = raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(
          /^\[\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\]\s*/,
          "",
        )
        .trim(),
    )
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !/^(?:whisper_|system_info|main:|load_|sherpa-onnx|error:|warning:)/i.test(
          line,
        ),
    );
  for (const line of lines.toReversed()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        return parsed.text.trim().slice(0, MAX_TRANSCRIPT_CHARS);
      }
    } catch {
      // 不是完整 JSON 的日志行，继续向前查找。
    }
  }
  return lines
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

function readOptionalText(file: string): string | null {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function engineLabel(engine: string): string {
  return engine === "sherpa" ? "sherpa-onnx" : "whisper.cpp";
}

function providerName(settings: Settings): string {
  return settings.voice.provider_config
    ? `${settings.voice.provider}:${settings.voice.provider_config}`
    : settings.voice.provider;
}
