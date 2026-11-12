import type {
  AgentEvent,
  AgentKernel,
  AgentRunContext,
  AgentRunInput,
  ChatMessage,
  ExpertName,
  PersistedAgentMessage,
  ToolCall,
} from "@soul-mate/agent-contracts";
import { AGENT_CONTRACT_VERSION } from "@soul-mate/agent-contracts";
import {
  DEFAULT_EMOTION,
  isEmotionPrefix,
  parseEmotionTag,
  salvageEmotionPrefix,
} from "./emotion.js";
import { classifyIntent } from "./intent.js";
import { buildChatPrompt, buildInfoPrompt } from "./prompts.js";

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as { type: unknown }).type === "text" &&
          "text" in block &&
          typeof (block as { text: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return content == null ? "" : String(content);
}

function assistantWithToolCalls(
  text: string,
  toolCalls: ToolCall[],
): ChatMessage {
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function toolResultMessage(
  toolCall: ToolCall,
  content: string,
): ChatMessage {
  return {
    role: "tool",
    content,
    name: toolCall.name,
    toolCallId: toolCall.id,
  };
}

function safeToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class TypeScriptAgentKernel implements AgentKernel {
  readonly id = "typescript";
  readonly contractVersion = AGENT_CONTRACT_VERSION;

  async close(): Promise<void> {
    return;
  }

  async *run(
    input: AgentRunInput,
    context: AgentRunContext,
    outerSignal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) {
      abort();
    } else {
      outerSignal?.addEventListener("abort", abort, { once: true });
    }
    let timeoutTriggered = false;
    const timeoutTimer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(new Error("run_timeout"));
    }, context.runTimeoutMs);
    timeoutTimer.unref?.();
    const signal = controller.signal;

    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let toolSteps = 0;
    let expert: ExpertName = "chat";
    const persisted: PersistedAgentMessage[] = [];

    yield { type: "run_started", data: {} };

    try {
      const classified = await classifyIntent(
        context.model,
        input.text,
        withTimeout(signal, 10_000),
      );
      expert = classified.intent;
      tokensIn += classified.tokensIn;
      tokensOut += classified.tokensOut;
      yield { type: "expert_selected", data: { expert } };

      const summary = await context.history.loadSummary(input.sessionId);
      const recall = await context.recall.recall(input.text, signal);
      const history = await context.history.loadRecent(input.sessionId, {
        maxTurns: context.historyTurns,
        ...(input.currentUserMessageId
          ? { excludeMessageId: input.currentUserMessageId }
          : {}),
      });

      const systemParts = [context.systemPrompt];
      if (summary) {
        systemParts.push(`【对话摘要】\n${summary}`);
      }
      if (recall) {
        systemParts.push(recall);
      }

      const systemPrompt = systemParts.join("\n\n");

      const toolContext = {
        requestId: input.requestId,
        sessionId: input.sessionId,
        expert,
        signal,
      };
      const toolDefinitions = await context.tools.listTools(toolContext);
      const visionAvailable = toolDefinitions.some(
        (tool) => tool.name === "look_through_camera",
      );
      const prompt =
        expert === "info"
          ? buildInfoPrompt(systemPrompt)
          : buildChatPrompt(systemPrompt, visionAvailable);
      const visibleTopLevelTools =
        expert === "chat"
          ? toolDefinitions.filter(
              (tool) =>
                tool.name === "look_through_camera" ||
                tool.name.startsWith("mcp__"),
            )
          : toolDefinitions;

      const baseMessages: ChatMessage[] = [
        { role: "system", content: prompt },
        ...history,
        { role: "user", content: input.text },
      ];
      let streamMessages = baseMessages;
      let pendingTools: ChatMessage[] = [];
      let shouldContinue = true;

      while (shouldContinue) {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("cancelled");
        }

        const availableTools =
          toolSteps < context.maxToolSteps ? visibleTopLevelTools : [];
        let responseText = "";
        let responseTools: ToolCall[] = [];
        let emotionBuffer = "";
        let emotionResolved = false;
        let detectedEmotion = false;
        let chunkTokensIn = 0;
        let chunkTokensOut = 0;

        const emitEmotion = async (emotion: string): Promise<AgentEvent> => ({
          type: "emotion",
          data: { emotion },
        });

        const flushAsText = (value: string): void => {
          if (!value) {
            emotionResolved = true;
            return;
          }
          const salvaged = detectedEmotion
            ? { emotion: null, consumed: 0 }
            : salvageEmotionPrefix(value);
          const rest =
            salvaged.emotion === null ? value : value.slice(salvaged.consumed);
          if (salvaged.emotion !== null) {
            detectedEmotion = true;
            responseText += `__EMOTION__${salvaged.emotion}__`;
          }
          emotionBuffer = "";
          emotionResolved = true;
          if (rest) {
            responseText += rest;
            text += rest;
          }
        };

        for await (const chunk of context.model.stream(streamMessages, {
          ...(availableTools.length > 0
            ? {
                tools: availableTools,
              }
            : {}),
          signal,
        })) {
          if (signal.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error("cancelled");
          }

          if (chunk.delta) {
            if (emotionResolved) {
              responseText += chunk.delta;
              text += chunk.delta;
            } else {
              emotionBuffer += chunk.delta;
              const parsed = parseEmotionTag(emotionBuffer);
              if (parsed.emotion !== null) {
                detectedEmotion = true;
                const rest = emotionBuffer.slice(parsed.consumed);
                emotionBuffer = "";
                emotionResolved = true;
                yield await emitEmotion(parsed.emotion);
                if (rest) {
                  responseText += rest;
                  text += rest;
                  yield { type: "text_delta", data: { text: rest } };
                }
              } else if (
                emotionBuffer.length > 100 ||
                !isEmotionPrefix(emotionBuffer)
              ) {
                flushAsText(emotionBuffer);
                const visible = responseText.replace(
                  /^__EMOTION__([a-z]+)__/,
                  "",
                );
                const emitted = visible.slice(
                  Math.max(0, visible.length - emotionBuffer.length),
                );
                if (emitted) {
                  yield { type: "text_delta", data: { text: emitted } };
                }
              }
            }
          }

          if (chunk.toolCalls) {
            if (!emotionResolved && emotionBuffer) {
              flushAsText(emotionBuffer);
              const visible = responseText.replace(
                /^__EMOTION__([a-z]+)__/,
                "",
              );
              const emitted = visible.slice(
                Math.max(0, visible.length - emotionBuffer.length),
              );
              if (emitted) {
                yield { type: "text_delta", data: { text: emitted } };
              }
            }
            responseTools = chunk.toolCalls;
          }

          if (chunk.tokensIn !== undefined) {
            chunkTokensIn = chunk.tokensIn;
          }
          if (chunk.tokensOut !== undefined) {
            chunkTokensOut = chunk.tokensOut;
          }
        }

        if (!emotionResolved) {
          const buffer = emotionBuffer;
          if (buffer) {
            const salvaged = salvageEmotionPrefix(buffer);
            if (salvaged.emotion !== null) {
              detectedEmotion = true;
              emotionBuffer = "";
              emotionResolved = true;
              yield await emitEmotion(salvaged.emotion);
              const rest = buffer.slice(salvaged.consumed);
              if (rest) {
                responseText += rest;
                text += rest;
                yield { type: "text_delta", data: { text: rest } };
              }
            } else {
              responseText += buffer;
              text += buffer;
              yield { type: "text_delta", data: { text: buffer } };
              emotionResolved = true;
            }
          } else {
            emotionResolved = true;
          }
        }

        if (!detectedEmotion) {
          yield { type: "emotion", data: { emotion: DEFAULT_EMOTION } };
        }

        tokensIn += chunkTokensIn;
        tokensOut += chunkTokensOut;

        const cleanText = responseText.replace(
          /^__EMOTION__([a-z]+)__/,
          "",
        );
        const assistant = assistantWithToolCalls(cleanText, responseTools);
        if (cleanText || responseTools.length > 0) {
          persisted.push({
            role: "assistant",
            content: cleanText,
            ...(responseTools.length > 0
              ? { toolCalls: responseTools }
              : {}),
          });
        }

        if (responseTools.length === 0) {
          shouldContinue = false;
          break;
        }

        if (toolSteps >= context.maxToolSteps) {
          yield {
            type: "error",
            data: {
              code: "tool_loop_limit",
              message: "工具调用次数超限",
            },
          };
          return;
        }

        const nextToolMessages: ChatMessage[] = [];
        let deniedReason: string | null = null;
        for (const call of responseTools) {
          if (deniedReason !== null) {
            const reason = "同一批工具请求已取消";
            yield {
              type: "tool_call_started",
              data: {
                request_id: toolContext.requestId,
                tool_call_id: call.id,
                tool: call.name,
                args: safeToolArguments(call.arguments),
              },
            };
            yield {
              type: "tool_denied",
              data: {
                request_id: toolContext.requestId,
                tool_call_id: call.id,
                tool: call.name,
                reason,
              },
            };
            const content = `用户拒绝执行：${deniedReason}`;
            nextToolMessages.push(toolResultMessage(call, content));
            persisted.push({
              role: "tool",
              content,
              name: call.name,
              toolCallId: call.id,
            });
            continue;
          }

          let terminal: "result" | "denied" | null = null;
          let resultContent = "";

          for await (const toolEvent of context.tools.execute(call, toolContext)) {
            if (toolEvent.type === "tool_result") {
              terminal = "result";
              resultContent = toolEvent.data.ok
                ? toolEvent.data.content
                : `工具执行失败：${toolEvent.data.error ?? "未知错误"}`;
            } else if (toolEvent.type === "tool_denied") {
              terminal = "denied";
              deniedReason = toolEvent.data.reason;
            }
            yield toolEvent as AgentEvent;
          }

          if (terminal === "denied") {
            const reason = deniedReason ?? "用户拒绝";
            nextToolMessages.push(
              toolResultMessage(call, `用户拒绝执行：${reason}`),
            );
            persisted.push({
              role: "tool",
              content: `用户拒绝执行：${reason}`,
              name: call.name,
              toolCallId: call.id,
            });
            continue;
          }
          if (terminal !== "result") {
            nextToolMessages.push(toolResultMessage(call, "工具没有返回结果"));
            persisted.push({
              role: "tool",
              content: "工具没有返回结果",
              name: call.name,
              toolCallId: call.id,
            });
            continue;
          }
          nextToolMessages.push(toolResultMessage(call, resultContent));
          persisted.push({
            role: "tool",
            content: resultContent,
            name: call.name,
            toolCallId: call.id,
          });
        }

        if (deniedReason !== null) {
          const decline = "……好，那便不动它了。若是需要，随时同我说。";
          text += decline;
          yield { type: "text_delta", data: { text: decline } };
          persisted.push({ role: "assistant", content: decline });
          yield {
            type: "run_finished",
            data: {
              text,
              tokens_in: tokensIn,
              tokens_out: tokensOut,
              model: context.modelName,
              messages: persisted,
            },
          };
          return;
        }

        toolSteps += 1;
        pendingTools = [...pendingTools, assistant, ...nextToolMessages];
        streamMessages = [
          ...baseMessages,
          ...pendingTools,
        ];
      }

      yield {
        type: "run_finished",
        data: {
          text,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model: context.modelName,
          messages: persisted,
        },
      };
    } catch (error) {
      if (timeoutTriggered) {
        yield {
          type: "error",
          data: { code: "run_timeout", message: "思考时间过长，请重试" },
        };
      } else if (signal.aborted) {
        yield {
          type: "error",
          data: { code: "cancelled", message: "生成被取消" },
        };
      } else {
        yield {
          type: "error",
          data: {
            code: "model_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } finally {
      clearTimeout(timeoutTimer);
      outerSignal?.removeEventListener("abort", abort);
    }
  }
}
