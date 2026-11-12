import type {
  ChatMessage,
  ModelPort,
  ModelStreamChunk,
  ModelStreamOptions,
  ToolCall,
  ToolDefinition,
} from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content || "",
  };
  if (message.name) result.name = message.name;
  if (message.toolCallId) result.tool_call_id = message.toolCallId;
  if (message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
  }
  return result;
}

function toToolSchema(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class RetryableHttpError extends Error {}

export class OpenAICompatibleModel implements ModelPort {
  constructor(private readonly config: Settings["model"]) {}

  async *stream(
    messages: readonly ChatMessage[],
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelStreamChunk> {
    const attempts = Math.max(1, this.config.max_retries + 1);
    let delivered = false;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const stats = { chunks: 0, status: 0, firstTokenAt: 0 };
      try {
        for await (const chunk of this.streamOnce(messages, options, stats)) {
          if (chunk.delta || chunk.toolCalls?.length) {
            delivered = true;
          }
          yield chunk;
        }
        return;
      } catch (error) {
        if (
          delivered ||
          signalAborted(options.signal) ||
          attempt >= attempts ||
          !isRetryable(error)
        ) {
          throw error;
        }
        const delay = this.config.retry_base_delay_s * 2 ** (attempt - 1);
        console.warn(
          `[模型] 请求失败（第 ${attempt}/${attempts} 次，状态码=${stats.status}），${delay} 秒后重试`,
        );
        await sleep(delay * 1000, options.signal ?? new AbortController().signal);
      }
    }
  }

  private async *streamOnce(
    messages: readonly ChatMessage[],
    options: ModelStreamOptions,
    stats: { chunks: number; status: number; firstTokenAt: number },
  ): AsyncIterable<ModelStreamChunk> {
    const signal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(this.config.timeout_s * 1000),
        ])
      : AbortSignal.timeout(this.config.timeout_s * 1000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.api_key) {
      headers.Authorization = `Bearer ${this.config.api_key}`;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(toOpenAiMessage),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.config.temperature,
      max_tokens: this.config.max_tokens,
    };
    if (options.tools?.length) {
      body.tools = options.tools.map(toToolSchema);
    }

    const response = await fetch(
      `${this.config.base_url.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      },
    );
    stats.status = response.status;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      const message = `模型接口返回 ${response.status}：${text}`;
      if (RETRYABLE_STATUS.has(response.status)) {
        throw new RetryableHttpError(message);
      }
      throw new Error(message);
    }
    if (!response.body) {
      throw new Error("模型接口没有返回流式响应体");
    }

    const buffers = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const raw = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (!raw.startsWith("data:")) continue;
          const data = raw.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data) as Record<string, unknown>;
          } catch {
            console.warn("[模型] 已忽略格式不正确的 SSE JSON 数据");
            continue;
          }

          const choices = Array.isArray(payload.choices) ? payload.choices : [];
          const choice =
            choices.length > 0
              ? (choices[0] as Record<string, unknown>)
              : {};
          const delta =
            typeof choice.delta === "object" && choice.delta !== null
              ? (choice.delta as Record<string, unknown>)
              : {};
          const content = typeof delta.content === "string" ? delta.content : "";
          const toolDeltas = Array.isArray(delta.tool_calls)
            ? delta.tool_calls
            : [];

          for (const rawTool of toolDeltas) {
            const tool = rawTool as Record<string, unknown>;
            const index = Number(tool.index ?? 0);
            const current = buffers.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (typeof tool.id === "string") current.id = tool.id;
            const fn =
              typeof tool.function === "object" && tool.function !== null
                ? (tool.function as Record<string, unknown>)
                : {};
            if (typeof fn.name === "string") current.name = fn.name;
            if (typeof fn.arguments === "string") {
              current.arguments += fn.arguments;
            }
            buffers.set(index, current);
          }

          const usage =
            typeof payload.usage === "object" && payload.usage !== null
              ? (payload.usage as Record<string, unknown>)
              : {};
          const chunk: ModelStreamChunk = {};
          if (content) chunk.delta = content;
          if (!stats.firstTokenAt && content) stats.firstTokenAt = Date.now();
          if (typeof choice.finish_reason === "string") {
            chunk.finishReason = choice.finish_reason;
          }
          if (typeof usage.prompt_tokens === "number") {
            chunk.tokensIn = usage.prompt_tokens;
          }
          if (typeof usage.completion_tokens === "number") {
            chunk.tokensOut = usage.completion_tokens;
          }
          stats.chunks += 1;
          if (
            chunk.delta ||
            chunk.finishReason ||
            chunk.tokensIn !== undefined ||
            chunk.tokensOut !== undefined
          ) {
            yield chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (buffers.size > 0) {
      const toolCalls: ToolCall[] = [...buffers.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, item]) => ({
          id: item.id || crypto.randomUUID(),
          name: item.name,
          arguments: item.arguments,
        }));
      yield { toolCalls };
    }
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TypeError" ||
    error.name === "TimeoutError" ||
    /fetch failed|network|ECONN|ENOTFOUND|socket/i.test(error.message)
  );
}
