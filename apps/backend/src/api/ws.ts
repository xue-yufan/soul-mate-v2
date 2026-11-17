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
import { parsePermissionReply } from "../permission/replies.js";
import { memoryRetrievalUnavailableReason } from "../memory/availability.js";

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
  connection_lost: "连接恢复超时",
  run_not_found: "找不到可恢复的回复",
};

interface Envelope {
  v?: unknown;
  type?: unknown;
  request_id?: unknown;
  session_id?: unknown;
  data?: unknown;
}

class Connection {
  readonly transportId = crypto.randomUUID().replaceAll("-", "");
  private clientId = this.transportId;
  readonly capabilities = new Set<string>();
  authenticated: boolean;
  memoryUnavailableNotified = false;
  transcribing: AbortController | null = null;

  constructor(
    readonly socket: WebSocket,
    readonly runtime: Runtime,
  ) {
    this.authenticated = !runtime.localToken;
  }

  get id(): string {
    return this.clientId;
  }

  setClientId(value: unknown): void {
    if (
      typeof value !== "string" ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(value)
    ) {
      return;
    }
    const previousId = this.clientId;
    this.clientId = value;
    this.runtime.realtime.replace(previousId, this);
  }

  sendRaw(event: Record<string, unknown>): boolean {
    if (this.socket.readyState !== this.socket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  send(
    type: string,
    data: Record<string, unknown> = {},
    options: {
      requestId?: string | null;
      sessionId?: string | null;
      record?: boolean;
    } = {},
  ): boolean {
    const requestId = options.requestId ?? null;
    const recorded =
      requestId && options.record !== false
        ? this.runtime.runs.record(requestId, type, data)
        : null;
    const event = {
      v: this.runtime.settings.contracts.ws_event_version,
      type,
      request_id: requestId,
      session_id:
        options.sessionId ?? this.runtime.settings.agent.default_session_id,
      ...(recorded ? { seq: recorded.seq } : {}),
      ts: recorded?.ts ?? new Date().toISOString(),
      data,
    };
    const target = this.runtime.realtime.current(this.id) ?? this;
    const sent = target.sendRaw(event);
    if (recorded && (type === "run_finished" || type === "error")) {
      this.runtime.runs.finish(requestId!);
    }
    return sent;
  }

  sendError(
    code: string,
    message = ERROR_MESSAGES[code] ?? "未知错误",
    requestId?: string | null,
  ): void {
    this.send("error", { code, message }, { requestId: requestId ?? null });
  }

  notifyMemoryUnavailable(reason: string): void {
    if (this.memoryUnavailableNotified) return;
    this.memoryUnavailableNotified = true;
    this.sendError(
      "memory_unavailable",
      `记忆检索不可用（${reason}），本轮回复不会使用长期记忆`,
    );
  }

  sendCaptureRequest(event: {
    captureId: string;
    question: string;
    reason: string;
    timeoutS: number;
  }): boolean {
    return this.send(
      "camera_capture_request",
      {
        capture_id: event.captureId,
        question: event.question,
        reason: event.reason,
        timeout_s: event.timeoutS,
      },
      { requestId: null },
    );
  }

  replayRun(
    requestId: string,
    sessionId: string,
    events: Array<{
      type: string;
      data: Record<string, unknown>;
      seq: number;
      ts: string;
    }>,
  ): void {
    for (const event of events) {
      this.sendRaw({
        v: this.runtime.settings.contracts.ws_event_version,
        type: event.type,
        request_id: requestId,
        session_id: sessionId,
        seq: event.seq,
        ts: event.ts,
        data: event.data,
      });
    }
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

async function handleNaturalPermissionReply(
  connection: Connection,
  sessionId: string,
  userText: string,
  requestId: string | null,
): Promise<boolean> {
  if (!connection.runtime.pending.hasOwner(connection.id)) return false;

  connection.runtime.database.insertUserMessage(sessionId, userText);
  const allowed = parsePermissionReply(userText);
  if (allowed === null) {
    const clarification =
      connection.runtime.persona.confirmClarification();
    connection.runtime.database.insertAssistantMessage(
      sessionId,
      clarification,
    );
    connection.send(
      "text_delta",
      { text: clarification },
      { requestId, sessionId },
    );
    return true;
  }

  if (
    !connection.runtime.pending.resolveForOwner(connection.id, allowed)
  ) {
    connection.sendError(
      "bad_request",
      "这次确认已经超时或结束",
      requestId,
    );
  }
  return true;
}

async function handleAudioInput(
  connection: Connection,
  message: Envelope,
): Promise<void> {
  const runtime = connection.runtime;
  const requestId = requestIdOf(message);
  if (!requestId) {
    connection.sendError("bad_request", "audio_input 必须提供 request_id");
    return;
  }
  if (!runtime.settings.features.voice) {
    connection.send(
      "transcription_error",
      {
        code: "asr_disabled",
        message: "本地语音输入未启用",
      },
      { requestId },
    );
    return;
  }
  const status = runtime.asr.status();
  if (!status.available) {
    connection.send(
      "transcription_error",
      {
        code: "asr_unavailable",
        message: status.message,
      },
      { requestId },
    );
    return;
  }
  if (
    connection.transcribing ||
    runtime.runs.hasActiveClient(connection.id)
  ) {
    connection.send(
      "transcription_error",
      {
        code: "busy",
        message: "上一轮对话或语音识别尚未结束",
      },
      { requestId },
    );
    return;
  }
  const data =
    typeof message.data === "object" && message.data !== null
      ? (message.data as Record<string, unknown>)
      : {};
  if (
    typeof data.audio !== "string" ||
    data.mime_type !== "audio/wav" ||
    data.sample_rate !== 16_000
  ) {
    connection.send(
      "transcription_error",
      {
        code: "bad_audio",
        message: "语音输入必须是 16 kHz WAV",
      },
      { requestId },
    );
    return;
  }
  const maxBytes =
    44 +
    runtime.settings.voice.max_audio_seconds *
      16_000 *
      2;
  if (
    data.audio.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio) ||
    Math.floor((data.audio.length * 3) / 4) > maxBytes
  ) {
    connection.send(
      "transcription_error",
      {
        code: "audio_too_large",
        message: `录音超过 ${runtime.settings.voice.max_audio_seconds} 秒或不是有效 Base64`,
      },
      { requestId },
    );
    return;
  }

  const controller = new AbortController();
  connection.transcribing = controller;
  connection.send(
    "transcription_started",
    { engine: status.engine },
    { requestId },
  );
  try {
    const result = await runtime.asr.transcribe(
      Buffer.from(data.audio, "base64"),
      controller.signal,
    );
    connection.send(
      "transcription_result",
      {
        text: result.text,
        engine: result.engine,
        elapsed_ms: result.elapsedMs,
      },
      { requestId },
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      connection.send(
        "transcription_error",
        {
          code: "asr_error",
          message: error instanceof Error ? error.message : String(error),
        },
        { requestId },
      );
    }
  } finally {
    if (connection.transcribing === controller) {
      connection.transcribing = null;
    }
  }
}

async function handleTextInput(
  connection: Connection,
  message: Envelope,
  version: number,
): Promise<void> {
  const runtime = connection.runtime;
  const settings = runtime.settings;
  const requestId = requestIdOf(message);
  if (!requestId) {
    connection.sendError("bad_request", "text_input 必须提供 request_id");
    return;
  }
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
  if (runtime.isShuttingDown) {
    connection.sendError(
      "internal_error",
      "服务正在关闭，暂不接受新请求",
      requestId,
    );
    return;
  }
  if (
    await handleNaturalPermissionReply(
      connection,
      sessionId,
      userText,
      requestId,
    )
  ) {
    return;
  }
  if (runtime.runs.hasActiveClient(connection.id) || connection.transcribing) {
    connection.sendError("busy", ERROR_MESSAGES.busy, requestId);
    return;
  }

  const memoryReason = memoryRetrievalUnavailableReason(
    settings,
    runtime.embedding.status(),
  );
  if (memoryReason) {
    connection.notifyMemoryUnavailable(memoryReason);
  }

  const controller = new AbortController();
  if (
    !runtime.runs.start({
      requestId,
      sessionId,
      clientId: connection.id,
      controller,
    })
  ) {
    connection.sendError("busy", ERROR_MESSAGES.busy, requestId);
    return;
  }
  const userMessageId = runtime.database.insertUserMessage(sessionId, userText);
  const tools = new RequestToolHost(
    settings,
    runtime.persona,
    runtime.pending,
    runtime.camera,
    runtime.mcp,
    connection.id,
    runtime.opencv,
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
        { requestId, sessionId, record: false },
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
        requestId,
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
        finished = true;
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

          void runtime.summary
            .maybeSummarize(sessionId)
            .catch((error: unknown) => {
              console.warn("[摘要] 后台更新失败：", error);
            });
          void runtime.extractor.extract(userText, fullText);
        },
      });
      if (event.type === "error") {
        finished = true;
      }
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
      if (prompt) {
        connection.runtime.database.insertAssistantMessage(
          context.sessionId,
          prompt,
        );
        context.tts.feed(prompt);
      }
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
      if (connection.authenticated) runtime.realtime.register(connection);

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
            connection.setClientId(data.client_id);
            connection.authenticated = true;
            runtime.realtime.register(connection);
            connection.send(
              "auth_ok",
              { client_id: connection.id },
              { requestId, record: false },
            );
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
          connection.setClientId(data.client_id);
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
        if (type === "resume_run") {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          const afterSeq = Number(data.after_seq ?? 0);
          if (
            !requestId ||
            !Number.isInteger(afterSeq) ||
            afterSeq < 0
          ) {
            connection.sendError(
              "bad_request",
              "resume_run 需要 request_id 和有效的 after_seq",
              requestId,
            );
            return;
          }
          const resumed = runtime.runs.resume(
            requestId,
            connection.id,
            afterSeq,
          );
          if (!resumed) {
            connection.sendError(
              "run_not_found",
              ERROR_MESSAGES.run_not_found,
              requestId,
            );
            return;
          }
          connection.replayRun(
            requestId,
            resumed.sessionId,
            resumed.events,
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
        if (type === "audio_input") {
          void handleAudioInput(connection, message).catch(
            (error: unknown) => {
              console.error("[语音输入] 处理失败：", error);
              connection.send(
                "transcription_error",
                {
                  code: "asr_error",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
                { requestId },
              );
            },
          );
          return;
        }
        if (type === "tool_confirm") {
          const data =
            typeof message.data === "object" && message.data !== null
              ? (message.data as Record<string, unknown>)
              : {};
          const confirmId =
            typeof data.confirm_id === "string" ? data.confirm_id : "";
          const resolved = runtime.pending.resolve(
            confirmId,
            data.allowed === true,
            connection.id,
          );
          if (!resolved) {
            connection.sendError(
              "bad_request",
              "这次确认已经超时或结束",
              requestId,
            );
          }
          return;
        }
        if (type === "text_input") {
          void handleTextInput(
            connection,
            message,
            runtime.settings.contracts.ws_event_version,
          ).catch((error: unknown) => {
            console.error("[WebSocket] 文字输入初始化失败：", error);
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
        connection.transcribing?.abort(new Error("连接已断开"));
        runtime.realtime.unregister(connection);
        if (runtime.runs.hasActiveClient(connection.id)) {
          const disconnectedId = connection.id;
          const cleanup = setTimeout(() => {
            if (runtime.realtime.current(disconnectedId) === undefined) {
              runtime.camera.unregister(connection);
            }
          }, 30_000);
          cleanup.unref();
        } else {
          runtime.camera.unregister(connection);
        }
        if (
          runtime.realtime.current(connection.id) === undefined ||
          runtime.realtime.current(connection.id) === connection
        ) {
          runtime.runs.markClientDisconnected(connection.id);
        }
      });
    },
  );
}
