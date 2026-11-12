import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type {
  AgentEvent,
  PersistedAgentMessage,
} from "@soul-mate/agent-contracts";
import type { Runtime } from "../runtime.js";
import { RequestToolHost } from "../agent/tool-host.js";
import { logAudit } from "../storage/audit.js";
import { TtsStream } from "../tts/index.js";

const ERROR_MESSAGES: Record<string, string> = {
  bad_json: "消息不是合法 JSON",
  bad_request: "缺少必填字段 v 或 type",
  unsupported_type: "不支持的消息类型",
  internal_error: "服务端处理消息时出错",
  model_error: "模型调用失败",
  recursion_limit: "思考步数超限",
  run_timeout: "思考时间过长",
  cancelled: "生成被取消",
  tool_loop_limit: "工具调用次数超限",
  memory_unavailable: "记忆检索不可用",
  busy: "上一轮还在进行中",
};

interface Envelope {
  v?: unknown;
  type?: unknown;
  request_id?: unknown;
  session_id?: unknown;
  data?: unknown;
}

class Connection {
  readonly capabilities = new Set<string>();
  authenticated: boolean;
  active: AbortController | null = null;
  memoryUnavailableNotified = false;

  constructor(
    readonly socket: WebSocket,
    readonly runtime: Runtime,
  ) {
    this.authenticated = !runtime.localToken;
  }

  send(
    type: string,
    data: Record<string, unknown> = {},
    options: { requestId?: string | null; sessionId?: string | null } = {},
  ): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        v: this.runtime.settings.contracts.ws_event_version,
        type,
        request_id: options.requestId ?? null,
        session_id:
          options.sessionId ?? this.runtime.settings.agent.default_session_id,
        ts: new Date().toISOString(),
        data,
      }),
    );
  }

  sendError(
    code: string,
    message = ERROR_MESSAGES[code] ?? "未知错误",
    requestId?: string | null,
  ): void {
    this.send("error", { code, message }, { requestId: requestId ?? null });
  }

  sendCaptureRequest(event: {
    captureId: string;
    question: string;
    reason: string;
    timeoutS: number;
  }): boolean {
    if (this.socket.readyState !== this.socket.OPEN) return false;
    this.send(
      "camera_capture_request",
      {
        capture_id: event.captureId,
        question: event.question,
        reason: event.reason,
        timeout_s: event.timeoutS,
      },
      { requestId: null },
    );
    return true;
  }
}

function parseEnvelope(raw: string): Envelope | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null
      ? (value as Envelope)
      : null;
  } catch {
    return null;
  }
}

function requestIdOf(message: Envelope): string | null {
  return typeof message.request_id === "string" &&
    message.request_id.trim() !== ""
    ? message.request_id
    : null;
}

function tokenMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function estimateCost(
  runtime: Runtime,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const price = runtime.settings.cost.prices[model];
  if (!price) return 0;
  return (
    (tokensIn / 1000) * price.input_per_1k +
    (tokensOut / 1000) * price.output_per_1k
  );
}

function isPersistedMessage(value: unknown): value is PersistedAgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    ((value as { role: unknown }).role === "assistant" ||
      (value as { role: unknown }).role === "tool") &&
    "content" in value &&
    typeof (value as { content: unknown }).content === "string"
  );
}

async function handleTextInput(
  connection: Connection,
  message: Envelope,
  version: number,
): Promise<void> {
  const runtime = connection.runtime;
  const settings = runtime.settings;
  const requestId = requestIdOf(message);
  const sessionId = settings.agent.default_session_id;
  const requestedSession = message.session_id;
  if (requestedSession !== undefined && requestedSession !== sessionId) {
    connection.sendError(
      "bad_request",
      `本应用只支持单一会话：${sessionId}`,
      requestId,
    );
    return;
  }
  if (connection.active) {
    connection.sendError("busy", ERROR_MESSAGES.busy, requestId);
    return;
  }
  const data =
    typeof message.data === "object" && message.data !== null
      ? (message.data as Record<string, unknown>)
      : {};
  const rawText = data.text;
  if (typeof rawText !== "string") {
    connection.sendError("bad_request", "data.text 必须是字符串", requestId);
    return;
  }
  const userText = rawText.trim();
  if (!userText) {
    connection.sendError("bad_request", "text 不能为空", requestId);
    return;
  }
  if (userText.length > 20_000) {
    connection.sendError("bad_request", "单次输入不能超过 20000 字", requestId);
    return;
  }

  const controller = new AbortController();
  connection.active = controller;
  const userMessageId = runtime.database.insertUserMessage(sessionId, userText);
  const tools = new RequestToolHost(
    settings,
    runtime.persona,
    runtime.pending,
    runtime.camera,
    runtime.mcp,
  );
  const tts = new TtsStream(
    settings,
    runtime.tts,
    (chunk, index) => {
      connection.send(
        "tts_audio_chunk",
        {
          audio: chunk.audio.toString("base64"),
          format: chunk.format,
          text: chunk.text,
          index,
        },
        { requestId, sessionId },
      );
    },
    controller.signal,
  );
  const toolMeta = new Map<
    string,
    { tool: string; args: Record<string, unknown> }
  >();
  let fullText = "";
  let finished = false;

  try {
    for await (const event of runtime.kernel.run(
      {
        text: userText,
        requestId: requestId ?? crypto.randomUUID(),
        sessionId,
        currentUserMessageId: userMessageId,
      },
      {
        ...runtime.context(),
        tools,
      },
      controller.signal,
    )) {
      if (settings.contracts.ws_event_version !== version) {
        connection.sendError(
          "bad_request",
          "契约版本已变化，请重连",
          requestId,
        );
        break;
      }
      await forwardAgentEvent(connection, event, {
        requestId,
        sessionId,
        tts,
        toolMeta,
        onText: (text) => {
          fullText += text;
        },
        onFinished: async (messages, tokensIn, tokensOut, model) => {
          finished = true;
          const lastAssistantId: { value: string | null } = { value: null };
          if (messages.length > 0) {
            runtime.database.persistAgentMessages(
              sessionId,
              messages,
              model,
              tokensIn,
              tokensOut,
              lastAssistantId,
            );
          }
          const estimatedCost = estimateCost(
            runtime,
            model,
            tokensIn,
            tokensOut,
          );
          runtime.database.writeCost(
            sessionId,
            lastAssistantId.value,
            settings.model.provider,
            model,
            tokensIn,
            tokensOut,
            estimatedCost,
            settings.cost.currency,
          );

          const ttsResult = await tts.finish();
          if (lastAssistantId.value && ttsResult.chars > 0) {
            runtime.database.updateTtsChars(
              lastAssistantId.value,
              ttsResult.chars,
            );
          }
          connection.send(
            "tts_finished",
            { chunks: ttsResult.chunks, chars: ttsResult.chars },
            { requestId, sessionId },
          );
          connection.send(
            "run_finished",
            {
              text: fullText,
              tokens_in: tokensIn,
              tokens_out: tokensOut,
              model,
              estimated_cost: estimatedCost,
              currency: settings.cost.currency,
            },
            { requestId, sessionId },
          );

          void runtime.extractor.extract(userText, fullText);
        },
      });
    }
    if (!finished && !controller.signal.aborted) {
      connection.sendError(
        "internal_error",
        "Agent 本轮没有正常结束",
        requestId,
      );
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error("[WebSocket] 文字输入处理失败：", error);
      connection.sendError(
        "internal_error",
        error instanceof Error ? error.message : String(error),
        requestId,
      );
    }
  } finally {
    tts.stop();
    connection.active = null;
  }
}

async function forwardAgentEvent(
  connection: Connection,
  event: AgentEvent,
  context: {
    requestId: string | null;
    sessionId: string;
    tts: TtsStream;
    toolMeta: Map<string, { tool: string; args: Record<string, unknown> }>;
    onText: (text: string) => void;
    onFinished: (
      messages: PersistedAgentMessage[],
      tokensIn: number,
      tokensOut: number,
      model: string,
    ) => Promise<void>;
  },
): Promise<void> {
  switch (event.type) {
    case "text_delta": {
      const text = String(event.data.text ?? "");
      context.onText(text);
      context.tts.feed(text);
      connection.send(
        "text_delta",
        { text },
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
        },
      );
      return;
    }
    case "emotion": {
      const emotion = String(event.data.emotion ?? "neutral");
      context.tts.setEmotion(emotion);
      connection.send(
        "emotion",
        { emotion },
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
        },
      );
      return;
    }
    case "run_started":
    case "expert_selected":
      connection.send(event.type, event.data, {
        requestId: context.requestId,
        sessionId: context.sessionId,
      });
      return;
    case "tool_call_started": {
      const id = String(event.data.tool_call_id ?? "");
      context.toolMeta.set(id, {
        tool: String(event.data.tool ?? ""),
        args:
          typeof event.data.args === "object" && event.data.args !== null
            ? (event.data.args as Record<string, unknown>)
            : {},
      });
      connection.send(event.type, event.data, {
        requestId: context.requestId,
        sessionId: context.sessionId,
      });
      return;
    }
    case "tool_confirm_request": {
      const prompt = String(event.data.prompt ?? "");
      if (prompt) context.tts.feed(prompt);
      connection.send(event.type, event.data, {
        requestId: context.requestId,
        sessionId: context.sessionId,
      });
      return;
    }
    case "tool_result":
    case "tool_denied": {
      const id = String(event.data.tool_call_id ?? "");
      const meta = context.toolMeta.get(id);
      logAudit(connection.runtime.database, {
        eventType: "tool_call",
        actor: "assistant",
        targetType: "tool",
        targetId: id,
        action: meta?.tool ?? String(event.data.tool ?? ""),
        before: { args: meta?.args ?? {} },
        after: {
          status:
            event.type === "tool_denied"
              ? "denied"
              : event.data.ok
                ? "ok"
                : "error",
          error: event.data.error ?? event.data.reason ?? null,
          chars: String(event.data.content ?? "").length,
        },
        status:
          event.type === "tool_denied"
            ? "denied"
            : event.data.ok
              ? "ok"
              : "error",
      });
      connection.send(event.type, event.data, {
        requestId: context.requestId,
        sessionId: context.sessionId,
      });
      return;
    }
    case "run_finished": {
      const messages = Array.isArray(event.data.messages)
        ? event.data.messages.filter(isPersistedMessage)
        : [];
      await context.onFinished(
        messages,
        Number(event.data.tokens_in ?? 0),
        Number(event.data.tokens_out ?? 0),
        String(event.data.model ?? ""),
      );
      return;
    }
    case "error":
      connection.sendError(
        String(event.data.code ?? "internal_error"),
        String(event.data.message ?? "未知错误"),
        context.requestId,
      );
      return;
  }
}

function validateEnvelope(
  message: Envelope,
  expectedVersion: number,
): { ok: boolean; code?: string } {
  if (message.v === undefined || message.type === undefined) {
    return { ok: false, code: "bad_request" };
  }
  if (
    typeof message.v !== "number" ||
    !Number.isInteger(message.v) ||
    message.v !== expectedVersion
  ) {
    return { ok: false, code: "version_mismatch" };
  }
  return { ok: true };
}

export function registerWebSocket(
  app: FastifyInstance,
  runtime: Runtime,
): void {
  app.get(
    runtime.settings.server.ws_path,
    { websocket: true },
    (socket: WebSocket, _request: FastifyRequest) => {
      const connection = new Connection(socket, runtime);

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
        const message = parseEnvelope(text);
        if (!message) {
          connection.sendError("bad_json");
          return;
        }
        const requestId = requestIdOf(message);
        if (!connection.authenticated) {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          if (
            message.type === "auth" &&
            runtime.localToken &&
            tokenMatches(runtime.localToken, data.token)
          ) {
            connection.authenticated = true;
          } else {
            connection.sendError(
              "unauthorized",
              "本地 WebSocket 鉴权失败",
              requestId,
            );
            socket.close(1008, "unauthorized");
          }
          return;
        }
        const valid = validateEnvelope(
          message,
          runtime.settings.contracts.ws_event_version,
        );
        if (!valid.ok) {
          if (valid.code === "version_mismatch") {
            connection.sendError(
              valid.code,
              `契约版本不匹配：客户端 ${String(message.v)}，服务端 ${runtime.settings.contracts.ws_event_version}`,
              requestId,
            );
          } else {
            connection.sendError(
              valid.code ?? "bad_request",
              undefined,
              requestId,
            );
          }
          return;
        }

        const type = String(message.type);
        if (type === "ping") {
          connection.send(
            "pong",
            { server_time: new Date().toISOString() },
            { requestId },
          );
          return;
        }
        if (type === "echo") {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          connection.send(
            "echo",
            {
              text: data.text,
              received_at: new Date().toISOString(),
            },
            { requestId },
          );
          return;
        }
        if (type === "client_hello") {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          const capabilities = Array.isArray(data.capabilities)
            ? data.capabilities.filter(
                (item): item is string => typeof item === "string",
              )
            : [];
          connection.capabilities.clear();
          for (const capability of capabilities) {
            connection.capabilities.add(capability);
          }
          if (connection.capabilities.has("camera")) {
            runtime.camera.register(connection);
          } else {
            runtime.camera.unregister(connection);
          }
          connection.send(
            "client_hello_ack",
            { capabilities: [...connection.capabilities] },
            { requestId },
          );
          return;
        }
        if (type === "camera_capture_result") {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          const captureId =
            typeof data.capture_id === "string" ? data.capture_id : "";
          let image: Buffer | undefined;
          if (data.ok === true && typeof data.image === "string") {
            try {
              image = Buffer.from(data.image, "base64");
            } catch {
              image = undefined;
            }
          }
          runtime.camera.resolve(connection, captureId, {
            ok: data.ok === true && Boolean(image),
            ...(image ? { image } : {}),
            ...(typeof data.mime_type === "string"
              ? { mimeType: data.mime_type }
              : {}),
            ...(typeof data.error === "string" ? { error: data.error } : {}),
          });
          return;
        }
        if (type === "tool_confirm") {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          const confirmId =
            typeof data.confirm_id === "string" ? data.confirm_id : "";
          runtime.pending.resolve(confirmId, data.allowed === true);
          return;
        }
        if (type === "text_input") {
          void handleTextInput(
            connection,
            message,
            runtime.settings.contracts.ws_event_version,
          ).catch((error: unknown) => {
            console.error("[WebSocket] 文字输入初始化失败：", error);
            connection.active = null;
            connection.sendError(
              "internal_error",
              error instanceof Error ? error.message : String(error),
              requestId,
            );
          });
          return;
        }
        connection.sendError(
          "unsupported_type",
          `不支持的消息类型：${type}`,
          requestId,
        );
      });

      socket.on("close", () => {
        connection.active?.abort(new Error("连接已断开"));
        runtime.camera.unregister(connection);
      });
    },
  );
}
