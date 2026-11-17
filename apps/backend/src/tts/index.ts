import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { backendRoot } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { SentenceSplitter } from "./splitter.js";

export interface AudioChunk {
  audio: Buffer;
  format: string;
  text: string;
  chars: number;
}

interface Reference {
  audio: string;
  text: string;
}

export interface TtsLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mode: "venv" | "uv" | "openvino";
}

const TTS_READY_TIMEOUT_MS = 90_000;
const TTS_PROBE_TIMEOUT_MS = 1_500;

export function resolveTtsLaunch(
  settings: Settings,
  options: {
    platform?: NodeJS.Platform;
    resourcesPath?: string;
    baseEnv?: NodeJS.ProcessEnv;
    backendRootDir?: string;
  } = {},
): TtsLaunch {
  const platform = options.platform ?? process.platform;
  const baseEnv = { ...(options.baseEnv ?? process.env) };
  if (settings.tts.provider === "openvino") {
    const backendDir = options.backendRootDir ?? backendRoot();
    const script = path.join(
      backendDir,
      "src",
      "tts",
      "openvino_tts_server.py",
    );
    const parsed = new URL(settings.tts.base_url);
    return {
      command: settings.tts.python_command,
      args: [
        script,
        "--model-dir",
        settings.tts.model_dir,
        "--host",
        parsed.hostname,
        "--port",
        parsed.port || "9880",
        "--device",
        settings.tts.device,
        "--speaker",
        settings.tts.speaker,
        "--language",
        settings.tts.language,
        "--instruct",
        settings.tts.instruct,
        "--cache-dir",
        path.join(path.dirname(settings.tts.model_dir), "tts-cache"),
      ],
      cwd: backendDir,
      env: baseEnv,
      mode: "openvino",
    };
  }
  const engineDir = path.resolve(settings.tts.engine_dir.trim());
  const venvDir = path.join(engineDir, ".venv");
  const scriptsDir = path.join(
    venvDir,
    platform === "win32" ? "Scripts" : "bin",
  );
  const configuredTtsConfig = baseEnv.GPT_SOVITS_TTS_CONFIG?.trim();
  const sourceTtsConfig = path.resolve(
    engineDir,
    configuredTtsConfig || "GPT_SoVITS/configs/tts_infer.yaml",
  );
  if (fs.existsSync(sourceTtsConfig)) {
    const writableTtsConfig = path.join(
      settings.paths.data_dir,
      "tts",
      "tts_infer.yaml",
    );
    if (path.resolve(writableTtsConfig) !== sourceTtsConfig) {
      fs.mkdirSync(path.dirname(writableTtsConfig), { recursive: true });
      fs.copyFileSync(sourceTtsConfig, writableTtsConfig);
    }
    baseEnv.GPT_SOVITS_TTS_CONFIG = writableTtsConfig;
  }
  const venvCommand = path.join(
    scriptsDir,
    platform === "win32" ? "gpt-sovits-api-v2.exe" : "gpt-sovits-api-v2",
  );
  if (fs.existsSync(venvCommand)) {
    const pathKey =
      Object.keys(baseEnv).find((key) => key.toUpperCase() === "PATH") ??
      "PATH";
    baseEnv.VIRTUAL_ENV = venvDir;
    baseEnv[pathKey] = [scriptsDir, baseEnv[pathKey]]
      .filter(Boolean)
      .join(path.delimiter);
    return {
      command: venvCommand,
      args: [],
      cwd: engineDir,
      env: baseEnv,
      mode: "venv",
    };
  }

  const uvCandidates = [
    baseEnv.SOUL_MATE_UV_EXE?.trim(),
    options.resourcesPath
      ? path.join(
          options.resourcesPath,
          "uv",
          platform === "win32" ? "uv.exe" : "uv",
        )
      : null,
    path.resolve(
      options.backendRootDir ?? backendRoot(),
      "../desktop/vendor/uv",
      platform === "win32" ? "uv.exe" : "uv",
    ),
  ].filter((item): item is string => Boolean(item));
  const command = uvCandidates.find((item) => fs.existsSync(item)) || "uv";
  const cacheDir = path.resolve(
    baseEnv.SOUL_MATE_UV_CACHE_DIR?.trim() ||
      path.join(settings.paths.data_dir, "uv-cache"),
  );
  fs.mkdirSync(cacheDir, { recursive: true });
  baseEnv.UV_CACHE_DIR = cacheDir;
  return {
    command,
    args: ["run", "--locked", "gpt-sovits-api-v2"],
    cwd: engineDir,
    env: baseEnv,
    mode: "uv",
  };
}

export async function probeTtsService(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/openapi.json`, {
      signal: AbortSignal.timeout(TTS_PROBE_TIMEOUT_MS),
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

class TtsEngineManager {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly settings: Settings) {}

  get enabled(): boolean {
    if (!this.settings.features.tts) return false;
    if (this.settings.tts.provider === "gpt_sovits") {
      return Boolean(this.settings.tts.engine_dir.trim());
    }
    if (this.settings.tts.provider === "openvino") {
      return Boolean(
        this.settings.tts.python_command &&
          this.settings.tts.model_dir &&
          this.settings.tts.base_url,
      );
    }
    return false;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.child) return;
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const baseUrl = this.settings.tts.base_url.trim();
    if (!baseUrl) {
      console.warn(`[语音] 已启用 ${this.settings.tts.provider}，但未配置 base_url`);
      return;
    }
    if (this.settings.tts.provider === "gpt_sovits") {
      const engineDir = path.resolve(this.settings.tts.engine_dir.trim());
      if (!fs.existsSync(engineDir)) {
        console.warn(`[语音] TTS 引擎目录不存在：${engineDir}`);
        return;
      }
    } else {
      if (!fs.existsSync(this.settings.tts.python_command)) {
        console.warn(
          `[语音] OpenVINO Python 不存在：${this.settings.tts.python_command}`,
        );
        return;
      }
      if (!fs.existsSync(this.settings.tts.model_dir)) {
        console.warn(`[语音] OpenVINO TTS 模型目录不存在：${this.settings.tts.model_dir}`);
        return;
      }
    }
    if (await probeTtsService(baseUrl)) {
      console.info(`[语音] 检测到 TTS 服务已运行：${baseUrl}`);
      return;
    }

    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    const launch = resolveTtsLaunch(
      this.settings,
      resourcesPath ? { resourcesPath } : {},
    );
    if (launch.mode === "venv") {
      console.info(`[语音] 正在启动 GPT-SoVITS（虚拟环境）：${launch.command}`);
    } else if (launch.mode === "uv") {
      console.info(
        `[语音] 正在启动 GPT-SoVITS（uv）：${launch.command} ${launch.args.join(" ")}`,
      );
      console.info(`[语音] UV 缓存目录：${launch.env.UV_CACHE_DIR}`);
    } else {
      console.info(
        `[语音] 正在启动 OpenVINO TTS：${launch.command} ${launch.args.join(" ")}`,
      );
    }
    try {
      this.child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      console.warn("[语音] 启动 TTS 引擎失败：", error);
      return;
    }

    let loggedStderrLines = 0;
    const stderrTail: string[] = [];
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (loggedStderrLines < 20) {
          loggedStderrLines += 1;
          console.warn(`[语音/TTS] ${line.trim()}`);
        } else {
          stderrTail.push(line.trim());
          if (stderrTail.length > 20) stderrTail.shift();
        }
      }
    });
    this.child.on("exit", (code, signal) => {
      if (stderrTail.length > 0) {
        console.warn("[语音/TTS] 退出前的尾部日志：");
        for (const line of stderrTail) {
          console.warn(`[语音/TTS] ${line}`);
        }
      }
      console.warn(`[语音] TTS 引擎已退出：code=${code}, signal=${signal}`);
      this.child = null;
    });
    this.child.on("error", (error) => {
      console.warn("[语音] TTS 启动器出错：", error);
      this.child = null;
    });

    const deadline = Date.now() + TTS_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) return;
      if (await probeTtsService(baseUrl)) {
        console.info(`[语音] TTS 服务已就绪：${baseUrl}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    console.warn("[语音] 等待 TTS 服务就绪超时，本轮继续以静音模式运行");
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    console.info("[语音] 正在关闭由应用启动的 TTS 服务");
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
      return;
    }
    child.kill("SIGTERM");
  }
}

function referenceFor(settings: Settings, emotion: string | null): Reference {
  if (settings.tts.ref_audio_dir && emotion) {
    const audio = path.join(settings.tts.ref_audio_dir, `${emotion}.wav`);
    const text = path.join(settings.tts.ref_audio_dir, `${emotion}.txt`);
    if (fs.existsSync(audio) && fs.existsSync(text)) {
      return {
        audio,
        text: fs.readFileSync(text, "utf-8").trim(),
      };
    }
  }
  return {
    audio: settings.tts.ref_audio,
    text: settings.tts.prompt_text,
  };
}

export class TtsAdapter {
  private readonly engine: TtsEngineManager;

  constructor(private readonly settings: Settings) {
    this.engine = new TtsEngineManager(settings);
  }

  get available(): boolean {
    if (!this.settings.features.tts) return false;
    if (this.settings.tts.provider === "gpt_sovits") {
      return Boolean(
        this.settings.tts.base_url &&
          this.settings.tts.ref_audio &&
          this.settings.tts.prompt_text,
      );
    }
    if (this.settings.tts.provider === "openvino") {
      return Boolean(
        this.settings.tts.base_url &&
          this.settings.tts.model_dir &&
          this.settings.tts.python_command,
      );
    }
    return false;
  }

  async synthesize(
    text: string,
    emotion: string | null,
    signal: AbortSignal,
  ): Promise<AudioChunk | null> {
    if (!this.available) return null;
    if (this.settings.tts.provider === "openvino") {
      const response = await fetch(
        `${this.settings.tts.base_url.replace(/\/$/, "")}/tts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            speaker: this.settings.tts.speaker,
            language: this.settings.tts.language,
            instruct: this.settings.tts.instruct,
            emotion,
          }),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(this.settings.tts.timeout_s * 1000),
          ]),
        },
      );
      if (!response.ok) {
        console.warn(`[语音] OpenVINO TTS 返回状态码 ${response.status}`);
        return null;
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) return null;
      return { audio, format: "wav", text, chars: text.length };
    }
    const reference = referenceFor(this.settings, emotion);
    const response = await fetch(
      `${this.settings.tts.base_url.replace(/\/$/, "")}/tts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          text_lang: "zh",
          ref_audio_path: reference.audio,
          prompt_text: reference.text,
          prompt_lang: "zh",
          media_type: "wav",
          streaming_mode: false,
          temperature: this.settings.tts.temperature,
          top_k: this.settings.tts.top_k,
          top_p: this.settings.tts.top_p,
        }),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.settings.tts.timeout_s * 1000),
        ]),
      },
    );
    if (!response.ok) {
      console.warn(`[语音] GPT-SoVITS 返回状态码 ${response.status}`);
      return null;
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) return null;
    return { audio, format: "wav", text, chars: text.length };
  }

  async startEngine(): Promise<void> {
    await this.engine.start();
  }

  async close(): Promise<void> {
    await this.engine.close();
  }
}

export class TtsStream {
  private readonly splitter: SentenceSplitter;
  private readonly queue: string[] = [];
  private drainPromise: Promise<void> | null = null;
  private emotion: string | null = null;
  private chunks = 0;
  private chars = 0;
  private stopped = false;

  constructor(
    private readonly settings: Settings,
    private readonly adapter: TtsAdapter,
    private readonly emit: (chunk: AudioChunk, index: number) => void,
    private readonly signal: AbortSignal,
  ) {
    this.splitter = new SentenceSplitter(settings.tts);
  }

  get enabled(): boolean {
    return this.adapter.available;
  }

  setEmotion(emotion: string): void {
    if (this.emotion === null) this.emotion = emotion;
  }

  feed(text: string): void {
    if (!this.enabled || this.stopped) return;
    for (const sentence of this.splitter.feed(text)) {
      this.queue.push(sentence);
    }
    void this.ensureDrain();
  }

  async finish(): Promise<{ chunks: number; chars: number }> {
    if (!this.enabled || this.stopped) return { chunks: 0, chars: 0 };
    for (const sentence of this.splitter.flush()) this.queue.push(sentence);
    while (
      !this.stopped &&
      (this.queue.length > 0 || this.drainPromise !== null)
    ) {
      await this.ensureDrain();
    }
    return { chunks: this.chunks, chars: this.chars };
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private ensureDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const promise = this.drain().finally(() => {
      if (this.drainPromise === promise) {
        this.drainPromise = null;
      }
    });
    this.drainPromise = promise;
    return promise;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const sentence = this.queue.shift()!;
        if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
        const result = await this.adapter.synthesize(
          sentence,
          this.emotion,
          this.signal,
        );
        if (!result || this.stopped) continue;
        if (this.chars + result.chars > this.settings.tts.max_chars_per_turn) {
          this.queue.length = 0;
          break;
        }
        this.emit(result, this.chunks);
        this.chunks += 1;
        this.chars += result.chars;
      }
    } catch (error) {
      if (!this.signal.aborted) {
        console.warn("[语音] 合成失败：", error);
      }
    }
  }
}
