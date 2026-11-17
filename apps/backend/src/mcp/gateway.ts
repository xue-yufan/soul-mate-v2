import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  backendRoot,
  type McpServerSettings,
  type Settings,
} from "../config/settings.js";

const GATEWAY_PROTOCOL_VERSION = 1;
const MAX_STDOUT_BUFFER = 16_000_000;
const MAX_STDIN_BUFFER = 4_000_000;

interface GatewayEnvelope {
  v?: number;
  id?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface GatewayEvent {
  server: string;
  stream: string;
  message: string;
}

function defaultGatewayCommand(): string | null {
  const executable =
    process.platform === "win32"
      ? "soul-mate-mcp-rust.exe"
      : "soul-mate-mcp-rust";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    process.env.SOUL_MATE_MCP_RUST_BIN?.trim() || null,
    path.resolve(backendRoot(), "../../.cargo-target/release", executable),
    resourcesPath ? path.resolve(resourcesPath, "mcp-rust", executable) : null,
  ].filter((item): item is string => Boolean(item));
  return candidates.find((item) => fs.existsSync(item)) ?? null;
}

export class McpGatewayClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private available = false;

  constructor(
    private readonly settings: Settings,
    private readonly server: McpServerSettings,
    private readonly onEvent: (event: GatewayEvent) => void,
  ) {}

  async start(): Promise<unknown[]> {
    if (this.available) return [];
    const command = defaultGatewayCommand();
    if (!command) {
      throw new Error("Rust MCP 网关不存在：请先运行 npm run build:rust-mcp");
    }
    await this.spawnGateway(command);
    const result = await this.requestControl(
      "start",
      {
        id: this.server.id,
        command: this.server.command,
        args: this.server.args,
        env: this.server.env,
        cwd: this.server.cwd,
        connectTimeoutMs: this.settings.mcp.connect_timeout_s * 1000,
        listTimeoutMs: this.settings.mcp.call_timeout_s * 1000,
      },
      this.settings.mcp.connect_timeout_s * 1000 + 5_000,
    );
    const tools = result.tools;
    if (!Array.isArray(tools)) {
      throw new Error("Rust MCP 网关未返回工具数组");
    }
    this.available = true;
    return tools;
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.available) {
      throw new Error(`MCP 服务 ${this.server.id} 不可用`);
    }
    if (signal.aborted) throw abortReason(signal);
    if (!tool.trim() || tool.length > 256) {
      throw new Error("MCP 工具名称无效");
    }
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > 1_000_000) {
      throw new Error("MCP 工具参数超过 1 MB");
    }
    const callId = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(callId);
        callback();
      };
      const onAbort = (): void => {
        void this.requestControl("cancel", { callId }, 2_000).catch(() => {
          // 网关可能已经退出。
        });
        finish(() => reject(abortReason(signal)));
      };
      const timer = setTimeout(
        () => {
          void this.requestControl("cancel", { callId }, 2_000).catch(() => {
            // 网关可能已经退出。
          });
          finish(() => reject(new Error("MCP 工具调用超时")));
        },
        this.settings.mcp.call_timeout_s * 1000 + 5_000,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(callId, {
        resolve: (payload) =>
          finish(() => {
            if (payload.ok === true) {
              resolve(
                typeof payload.result === "object" && payload.result !== null
                  ? (payload.result as Record<string, unknown>)
                  : { content: [] },
              );
            } else {
              reject(new Error(String(payload.error ?? "MCP 工具调用失败")));
            }
          }),
        reject: (error) => finish(() => reject(error)),
        timer,
      });
      try {
        this.write({
          v: GATEWAY_PROTOCOL_VERSION,
          id: callId,
          kind: "call",
          payload: {
            tool,
            arguments: args,
            timeoutMs: this.settings.mcp.call_timeout_s * 1000,
          },
        });
      } catch (error) {
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.available = false;
    this.failAll(new Error(`MCP 服务 ${this.server.id} 正在关闭`));
    if (!child) return;
    try {
      child.stdin.write(
        `${JSON.stringify({
          v: GATEWAY_PROTOCOL_VERSION,
          id: "shutdown",
          kind: "shutdown",
          payload: {},
        })}\n`,
      );
      child.stdin.end();
    } catch {
      // 网关可能已经退出。
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        terminateTree(child.pid);
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async spawnGateway(command: string): Promise<void> {
    const child = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          this.onEvent({
            server: this.server.id,
            stream: "gateway",
            message: line.trim(),
          });
        }
      }
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.child = null;
      this.available = false;
      this.failAll(
        new Error(`Rust MCP 网关已退出：code=${code}, signal=${signal}`),
      );
    });
    await this.requestControl("ping", {}, 5_000);
  }

  private requestControl(
    kind: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error("Rust MCP 网关未启动"));
    }
    const id = `control:${crypto.randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Rust MCP 网关请求超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({
          v: GATEWAY_PROTOCOL_VERSION,
          id,
          kind,
          payload,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("Rust MCP 网关 stdin 不可写");
    }
    if (child.stdin.writableLength > MAX_STDIN_BUFFER) {
      throw new Error("Rust MCP 网关 stdin 队列超过上限");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER) {
      this.failAll(new Error("Rust MCP 网关输出超过上限"));
      terminateTree(this.child?.pid);
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: GatewayEnvelope;
      try {
        message = JSON.parse(line) as GatewayEnvelope;
      } catch {
        this.onEvent({
          server: this.server.id,
          stream: "gateway",
          message: "Rust MCP 网关返回了非法 JSON",
        });
        continue;
      }
      this.route(message);
    }
  }

  private route(message: GatewayEnvelope): void {
    if (message.v !== GATEWAY_PROTOCOL_VERSION) {
      this.failAll(
        new Error(`Rust MCP 网关协议版本不匹配：${String(message.v)}`),
      );
      return;
    }
    if (message.kind === "mcp_event" && message.payload) {
      this.onEvent({
        server: String(message.payload.server ?? this.server.id),
        stream: String(message.payload.stream ?? "stderr"),
        message: String(message.payload.message ?? ""),
      });
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.kind === "error") {
      pending.reject(
        new Error(String(message.payload?.message ?? "Rust MCP 网关请求失败")),
      );
    } else {
      pending.resolve(message.payload ?? {});
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("MCP 工具调用已取消");
}

function terminateTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 进程可能已经退出。
    }
  }
}
