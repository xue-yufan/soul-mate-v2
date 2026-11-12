import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  AgentKernel,
  AgentRunContext,
  AgentRunInput,
  ChatMessage,
  KernelHostResultPayload,
  ToolCall,
  ToolDefinition,
} from "@soul-mate/agent-contracts";
import { AGENT_CONTRACT_VERSION } from "@soul-mate/agent-contracts";
import { backendRoot } from "../config/settings.js";

const MAX_ACTIVE_RUNS = 64;
const MAX_RUN_QUEUE_EVENTS = 4_096;
const MAX_STDIN_BUFFER_BYTES = 8_000_000;

interface IpcEnvelope {
  v?: number;
  id?: string;
  run_id?: string;
  kind?: string;
  method?: string;
  payload?: Record<string, unknown>;
}

interface RunState {
  input: AgentRunInput;
  context: AgentRunContext;
  controller: AbortController;
  queue: AgentEvent[];
  wake: (() => void) | null;
  done: boolean;
}

interface ControlRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function defaultRustCommand(): string | null {
  const executable =
    process.platform === "win32"
      ? "soul-mate-agent-rust.exe"
      : "soul-mate-agent-rust";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    process.env.SOUL_MATE_RUST_AGENT_BIN?.trim() || null,
    path.resolve(backendRoot(), "../../.tmp-cargo-target/release", executable),
    path.resolve(
      backendRoot(),
      "../../packages/agent-rust/target/release",
      executable,
    ),
    resourcesPath
      ? path.resolve(resourcesPath, "agent-rust", executable)
      : null,
  ].filter((item): item is string => Boolean(item));
  return candidates.find((item) => fs.existsSync(item)) ?? null;
}

export class RustSidecarKernel implements AgentKernel {
  readonly id = "rust-sidecar";
  readonly contractVersion = AGENT_CONTRACT_VERSION;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private runs = new Map<string, RunState>();
  private control = new Map<string, ControlRequest>();
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
  ) {}

  private resolvedCommand(): string {
    const configured = this.command.trim();
    const command = configured || defaultRustCommand();
    if (!command) {
      throw new Error(
        "Rust Agent sidecar 不存在：请设置 agent.rust_command 或先运行 npm run build:rust",
      );
    }
    return command;
  }

  private ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const command = this.resolvedCommand();
    console.info(`[Agent] 正在启动 Rust sidecar：${command}`);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => this.onStdout(data));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data: string) => {
        for (const line of data.split(/\r?\n/)) {
          if (line.trim()) console.info(line.trim());
        }
      });
      child.once("error", (error) => {
        this.child = null;
        this.readyPromise = null;
        reject(error);
        this.failAll(error);
      });
      child.once("exit", (code, signal) => {
        const error = new Error(
          `Rust Agent sidecar 已退出：code=${code}, signal=${signal}`,
        );
        this.child = null;
        this.readyPromise = null;
        this.failAll(error);
      });
      this.requestControl("ping").then(
        () => {
          console.info("[Agent] Rust sidecar 握手完成");
          resolve();
        },
        (error: unknown) => {
          this.child = null;
          this.readyPromise = null;
          child.kill();
          reject(error);
        },
      );
    });
    return this.readyPromise;
  }

  private requestControl(kind: string): Promise<void> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Rust Agent sidecar 未启动"));
    const id = `control:${crypto.randomUUID()}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.control.delete(id);
        reject(new Error("Rust Agent sidecar 握手超时"));
      }, 5_000);
      this.control.set(id, { resolve, reject, timer });
      try {
        this.write({ v: AGENT_CONTRACT_VERSION, id, kind, payload: {} });
      } catch (error) {
        this.control.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) {
      throw new Error("Rust Agent sidecar stdin 不可写");
    }
    if (this.child.stdin.writableLength > MAX_STDIN_BUFFER_BYTES) {
      throw new Error("Rust Agent sidecar stdin 写入队列超过上限");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16_000_000) {
      this.failAll(new Error("Rust Agent sidecar 输出超过上限"));
      this.child?.kill();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: IpcEnvelope;
      try {
        message = JSON.parse(line) as IpcEnvelope;
      } catch (error) {
        console.warn("[Rust Agent] 收到非法 JSON：", error);
        continue;
      }
      this.route(message);
    }
  }

  private route(message: IpcEnvelope): void {
    if (message.v !== AGENT_CONTRACT_VERSION) {
      const error = new Error(
        `Rust Agent 协议版本不匹配：${String(message.v)}`,
      );
      this.failAll(error);
      return;
    }
    if (message.kind === "pong" && message.id) {
      const pending = this.control.get(message.id);
      if (pending) {
        this.control.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve();
      }
      return;
    }
    if (message.kind === "host_call") {
      void this.handleHostCall(message);
      return;
    }
    if (
      (message.kind === "agent_event" || message.kind === "error") &&
      message.run_id
    ) {
      const run = this.runs.get(message.run_id);
      if (!run) return;
      const event =
        message.kind === "agent_event"
          ? (message.payload as unknown as AgentEvent)
          : {
              type: "error" as const,
              data: message.payload ?? {},
            };
      this.pushEvent(run, event);
    }
  }

  private pushEvent(run: RunState, event: AgentEvent): void {
    if (
      !run.done &&
      run.queue.length >= MAX_RUN_QUEUE_EVENTS &&
      event.type !== "error"
    ) {
      run.controller.abort(new Error("Rust Agent 事件队列超过上限"));
      try {
        this.write({
          v: AGENT_CONTRACT_VERSION,
          id: run.input.requestId,
          run_id: run.input.requestId,
          kind: "cancel",
          payload: {},
        });
      } catch {
        // 子进程可能已经退出。
      }
      run.queue = [
        {
          type: "error",
          data: {
            code: "event_queue_overflow",
            message: "Rust Agent 事件队列超过上限",
          },
        },
      ];
      run.done = true;
      run.wake?.();
      run.wake = null;
      return;
    }
    run.queue.push(event);
    if (event.type === "run_finished" || event.type === "error") {
      run.done = true;
    }
    run.wake?.();
    run.wake = null;
  }

  private async handleHostCall(message: IpcEnvelope): Promise<void> {
    const callId = message.id;
    const runId = message.run_id;
    const method = message.method;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!callId || !runId || !method || !run) {
      if (callId) {
        this.sendHostResult(callId, runId ?? "", {
          ok: false,
          done: true,
          error: "Rust Agent 宿主调用缺少运行上下文",
        });
      }
      return;
    }
    const payload = message.payload ?? {};
    const signal = run.controller.signal;
    try {
      switch (method) {
        case "model.stream": {
          const messages = payload.messages as ChatMessage[];
          const tools = payload.tools as ToolDefinition[] | undefined;
          for await (const chunk of run.context.model.stream(messages, {
            ...(tools?.length ? { tools } : {}),
            signal,
          })) {
            this.sendHostResult(callId, runId, {
              ok: true,
              stream: true,
              chunk,
            });
          }
          this.sendHostResult(callId, runId, {
            ok: true,
            stream: true,
            done: true,
          });
          return;
        }
        case "history.loadRecent": {
          const messages = await run.context.history.loadRecent(
            String(payload.sessionId ?? run.input.sessionId),
            {
              maxTurns: Number(payload.maxTurns ?? run.context.historyTurns),
              ...(typeof payload.excludeMessageId === "string"
                ? { excludeMessageId: payload.excludeMessageId }
                : {}),
            },
          );
          this.sendHostResult(callId, runId, {
            ok: true,
            done: true,
            data: { messages },
          });
          return;
        }
        case "history.loadSummary": {
          const summary = await run.context.history.loadSummary(
            String(payload.sessionId ?? run.input.sessionId),
          );
          this.sendHostResult(callId, runId, {
            ok: true,
            done: true,
            data: { summary },
          });
          return;
        }
        case "recall.query": {
          const text = await run.context.recall.recall(
            String(payload.query ?? ""),
            signal,
          );
          this.sendHostResult(callId, runId, {
            ok: true,
            done: true,
            data: { text },
          });
          return;
        }
        case "tools.list": {
          const tools = await run.context.tools.listTools({
            requestId: run.input.requestId,
            sessionId: run.input.sessionId,
            expert: payload.expert === "info" ? "info" : "chat",
            signal,
          });
          this.sendHostResult(callId, runId, {
            ok: true,
            done: true,
            data: { tools },
          });
          return;
        }
        case "tools.execute": {
          const call = payload.call as ToolCall;
          for await (const event of run.context.tools.execute(call, {
            requestId: run.input.requestId,
            sessionId: run.input.sessionId,
            expert: payload.expert === "info" ? "info" : "chat",
            signal,
          })) {
            this.sendHostResult(callId, runId, {
              ok: true,
              stream: true,
              chunk: event,
            });
          }
          this.sendHostResult(callId, runId, {
            ok: true,
            stream: true,
            done: true,
          });
          return;
        }
        case "run.cancelled": {
          this.sendHostResult(callId, runId, {
            ok: true,
            done: true,
          });
          return;
        }
        default:
          throw new Error(`不支持的宿主调用：${method}`);
      }
    } catch (error) {
      this.sendHostResult(callId, runId, {
        ok: false,
        done: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendHostResult(
    callId: string,
    runId: string,
    payload: KernelHostResultPayload,
  ): void {
    try {
      this.write({
        v: AGENT_CONTRACT_VERSION,
        id: callId,
        run_id: runId,
        kind: "host_result",
        payload,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.runs.get(runId)?.controller.abort(failure);
      this.child?.kill();
      this.failAll(failure);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.control.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.control.clear();
    for (const run of this.runs.values()) {
      if (!run.done) {
        this.pushEvent(run, {
          type: "error",
          data: { code: "internal_error", message: error.message },
        });
      }
    }
  }

  async *run(
    input: AgentRunInput,
    context: AgentRunContext,
    outerSignal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    await this.ensureReady();
    if (this.runs.size >= MAX_ACTIVE_RUNS) {
      yield {
        type: "error",
        data: { code: "too_many_runs", message: "并发运行数量已达上限" },
      };
      return;
    }
    if (this.runs.has(input.requestId)) {
      yield {
        type: "error",
        data: { code: "bad_request", message: "重复的运行 ID" },
      };
      return;
    }
    const controller = new AbortController();
    const run: RunState = {
      input,
      context,
      controller,
      queue: [],
      wake: null,
      done: false,
    };
    this.runs.set(input.requestId, run);
    const abort = () => {
      if (controller.signal.aborted) return;
      controller.abort(outerSignal?.reason);
      try {
        this.write({
          v: AGENT_CONTRACT_VERSION,
          id: input.requestId,
          run_id: input.requestId,
          kind: "cancel",
          payload: {},
        });
      } catch {
        // 子进程可能已经退出。
      }
    };
    outerSignal?.addEventListener("abort", abort, { once: true });
    try {
      this.write({
        v: AGENT_CONTRACT_VERSION,
        id: input.requestId,
        run_id: input.requestId,
        kind: "run",
        payload: {
          input,
          context: {
            systemPrompt: context.systemPrompt,
            modelName: context.modelName,
            historyTurns: context.historyTurns,
            maxToolSteps: context.maxToolSteps,
            runTimeoutMs: context.runTimeoutMs,
          },
        },
      });
      if (outerSignal?.aborted) abort();
      while (!run.done || run.queue.length > 0) {
        if (run.queue.length === 0) {
          await new Promise<void>((resolve) => {
            run.wake = resolve;
          });
          continue;
        }
        yield run.queue.shift()!;
      }
    } catch (error) {
      if (!run.done) {
        run.done = true;
        yield {
          type: "error",
          data: {
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } finally {
      outerSignal?.removeEventListener("abort", abort);
      if (!run.done && !controller.signal.aborted) abort();
      this.runs.delete(input.requestId);
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (!child) return;
    try {
      child.stdin.write(
        `${JSON.stringify({
          v: AGENT_CONTRACT_VERSION,
          id: "shutdown",
          kind: "shutdown",
          payload: {},
        })}\n`,
      );
      child.stdin.end();
    } catch {
      // ignore
    }
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await exited;
    this.failAll(new Error("Rust Agent sidecar 已关闭"));
  }
}
