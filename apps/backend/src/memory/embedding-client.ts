import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backendRoot, type Settings } from "../config/settings.js";
import {
  semanticScoresFromVectors,
  throwIfAborted,
  type EmbeddingClient,
  type EmbeddingStatus,
} from "./embedding-types.js";

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RustResponse {
  v?: number;
  id?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

export class RustEmbeddingClient implements EmbeddingClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = "";
  private loaded = false;
  private reason: string | null = null;
  private dimension: number | null = null;
  private cache = new Map<string, number[]>();

  constructor(private readonly settings: Settings) {}

  get enabled(): boolean {
    return (
      (this.settings.features.memory || this.settings.features.rag) &&
      Boolean(this.settings.paths.embed_model_dir)
    );
  }

  private command(): string | null {
    const configured = this.settings.embedding.rust_command.trim();
    const environment = process.env.SOUL_MATE_EMBEDDING_RUST_BIN?.trim();
    const executable =
      process.platform === "win32"
        ? "soul-mate-agent-rust.exe"
        : "soul-mate-agent-rust";
    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    const candidates = [
      configured || null,
      environment || null,
      path.resolve(
        backendRoot(),
        "../../.cargo-target/release",
        executable,
      ),
      path.resolve(
        backendRoot(),
        "../../packages/agent-rust/target/release",
        executable,
      ),
      path.resolve(resourcesPath ?? "", "agent-rust", executable),
    ].filter((item): item is string => Boolean(item));
    return candidates.find((item) => fs.existsSync(item)) ?? null;
  }

  status(): EmbeddingStatus {
    return {
      enabled: this.enabled,
      available: Boolean(this.enabled && this.command()),
      loaded: this.loaded,
      kernel: "sidecar",
      configuredKernel: this.settings.embedding.kernel,
      command: this.command(),
      addonPath: null,
      modelDir: this.settings.paths.embed_model_dir,
      dimension: this.dimension,
      reason: this.reason,
    };
  }

  async start(): Promise<void> {
    if (!this.enabled || this.loaded) return;
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const command = this.command();
    const modelDir = this.settings.paths.embed_model_dir;
    if (!command) {
      this.reason = "未找到 Rust 嵌入 sidecar 可执行文件";
      throw new Error(this.reason);
    }
    if (!modelDir || !fs.existsSync(modelDir)) {
      this.reason = `嵌入模型目录不存在：${modelDir ?? "未配置"}`;
      throw new Error(this.reason);
    }

    this.reason = null;
    console.info(`[嵌入] 正在启动 Rust sidecar：${command}`);
    const child = spawn(command, ["--model-dir", modelDir], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buffer = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) console.info(line.trim());
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.loaded = false;
      this.child = null;
      this.failAll(
        new Error(`Rust 嵌入 sidecar 已退出：code=${code}, signal=${signal}`),
      );
    });

    const pong = await this.request("ping", {}, 120_000);
    const dimension = Number(pong.dimension ?? 0);
    this.dimension =
      Number.isInteger(dimension) && dimension > 0 ? dimension : null;
    this.loaded = true;
    console.info("[嵌入] Rust sidecar 已就绪");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) {
      this.failAll(new Error("Rust 嵌入 sidecar 输出超过上限"));
      this.child?.kill();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let response: RustResponse;
      try {
        response = JSON.parse(line) as RustResponse;
      } catch (error) {
        console.warn("[嵌入] Rust sidecar 返回了非法 JSON：", error);
        continue;
      }
      if (typeof response.id !== "string") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.kind === "error") {
        pending.reject(
          new Error(String(response.payload?.message ?? "Rust 嵌入请求失败")),
        );
      } else {
        pending.resolve(response.payload ?? {});
      }
    }
  }

  private request(
    kind: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error("Rust 嵌入 sidecar 未启动"));
    }
    const id = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Rust 嵌入请求超时（${timeoutMs / 1000} 秒）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ v: 1, id, kind, payload }) + "\n");
    });
  }

  private failAll(error: Error): void {
    this.reason = error.message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const payload = await this.request("embed", { texts }, 120_000);
    const vectors = payload.vectors;
    if (!Array.isArray(vectors)) {
      throw new Error("Rust 嵌入响应缺少 vectors");
    }
    return vectors.map((vector) => {
      if (!Array.isArray(vector)) throw new Error("Rust 嵌入向量格式无效");
      return vector.map(Number);
    });
  }

  async embedTexts(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][] | null> {
    if (!this.enabled) return null;
    try {
      await this.start();
      throwIfAborted(signal);
      const unique = [...new Set(texts)];
      const missing = unique.filter((text) => !this.cache.has(text));
      const batchSize = Math.max(
        1,
        Math.min(64, this.settings.embedding.batch_size),
      );
      for (let offset = 0; offset < missing.length; offset += batchSize) {
        throwIfAborted(signal);
        const batch = missing.slice(offset, offset + batchSize);
        const vectors = await this.embedBatch(batch);
        for (let index = 0; index < batch.length; index += 1) {
          const vector = vectors[index];
          if (vector) this.cache.set(batch[index]!, vector);
        }
      }
      throwIfAborted(signal);
      while (this.cache.size > 4096) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      const first = unique[0] ? this.cache.get(unique[0]) : undefined;
      if (first) this.dimension = first.length;
      return texts.map((text) => this.cache.get(text) ?? []);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("嵌入请求已取消");
      }
      this.reason = error instanceof Error ? error.message : String(error);
      console.warn("[嵌入] 向量计算失败，回退词项检索：", this.reason);
      return null;
    }
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

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.loaded = false;
    this.failAll(new Error("Rust 嵌入 sidecar 正在关闭"));
    if (!child) return;
    child.stdin.end();
    child.kill();
  }
}
