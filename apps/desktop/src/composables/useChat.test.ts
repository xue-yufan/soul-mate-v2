import { effectScope, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChat, type UseChatResult } from "@/composables/useChat";
import {
  createFakeTts,
  createFakeWebSocket,
  serverEvent,
  textInput,
  type FakeWebSocket,
} from "@/test/helpers";

describe("useChat", () => {
  let ws: FakeWebSocket;
  let chat: UseChatResult;
  let scope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    vi.useFakeTimers();
    ws = createFakeWebSocket();
    scope = effectScope();
    chat = scope.run(() => useChat(ws.result, createFakeTts()))!;
  });

  afterEach(() => {
    scope.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("发送前去空白，并把 text_input 写入 WebSocket", () => {
    chat.sendText("  你好  ");

    expect(chat.messages.value).toHaveLength(1);
    expect(chat.messages.value[0]).toMatchObject({
      role: "user",
      content: "你好",
    });
    expect(textInput(ws.sent)?.data.text).toBe("你好");
  });

  it("忽略空消息", () => {
    chat.sendText("   \n\t ");

    expect(chat.messages.value).toEqual([]);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("流式拼接助手正文并在结束时写入统计", () => {
    chat.sendText("你好");
    ws.emit(serverEvent("run_started", {}));
    ws.emit(serverEvent("text_delta", { text: "你" }));
    ws.emit(serverEvent("text_delta", { text: "好" }));
    ws.emit(
      serverEvent("run_finished", {
        tokens_in: 12,
        tokens_out: 34,
        model: "deepseek-chat",
        estimated_cost: 0.01,
        currency: "CNY",
      }),
    );

    const assistant = chat.messages.value.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({
      content: "你好",
      streaming: false,
      stats: {
        tokensIn: 12,
        tokensOut: 34,
        model: "deepseek-chat",
      },
    });
    expect(chat.isGenerating.value).toBe(false);
  });

  it("权限请求通过 tool_confirm 明确允许或拒绝", () => {
    ws.emit(
      serverEvent("tool_call_started", {
        request_id: "request-1",
        tool_call_id: "call-1",
        tool: "read_file",
        args: { path: "notes.txt" },
      }),
    );
    ws.emit(
      serverEvent("tool_confirm_request", {
        request_id: "request-1",
        tool_call_id: "call-1",
        confirm_id: "confirm-1",
        tool: "read_file",
        args: { path: "notes.txt" },
        timeout_s: 30,
        prompt: "可以读吗？",
      }),
    );

    expect(chat.pendingConfirm.value?.confirmId).toBe("confirm-1");
    expect(chat.messages.value.at(-1)).toMatchObject({
      role: "assistant",
      content: "可以读吗？",
    });

    expect(chat.confirmTool(true)).toBe(true);
    expect(ws.sent.at(-1)).toMatchObject({
      type: "tool_confirm",
      request_id: "call-1",
      data: { confirm_id: "confirm-1", allowed: true },
    });
    expect(chat.pendingConfirm.value).toBeNull();

    ws.emit(
      serverEvent("tool_result", {
        request_id: "request-1",
        tool_call_id: "call-1",
        tool: "read_file",
        ok: true,
        content: "文件内容",
      }),
    );
  });

  it("待确认时可以发送自然语言回复，并展示后端澄清", () => {
    chat.isGenerating.value = true;
    ws.emit(
      serverEvent("tool_confirm_request", {
        request_id: "request-1",
        tool_call_id: "call-1",
        confirm_id: "confirm-1",
        tool: "read_file",
        args: { path: "notes.txt" },
        timeout_s: 30,
        prompt: "可以读吗？",
      }),
    );

    chat.sendText("可以");
    expect(chat.messages.value.at(-1)).toMatchObject({
      role: "user",
      content: "可以",
    });
    expect(textInput(ws.sent)?.data.text).toBe("可以");
    expect(chat.pendingConfirm.value?.confirmId).toBe("confirm-1");
    expect(chat.isGenerating.value).toBe(true);

    ws.emit(serverEvent("text_delta", { text: "请明确答复可以或不必了。" }));
    expect(chat.messages.value.at(-1)).toMatchObject({
      role: "assistant",
      content: "请明确答复可以或不必了。",
      streaming: false,
    });
  });

  it("连接中断时收尾进行中的工具和助手消息", async () => {
    ws.emit(serverEvent("run_started", {}));
    ws.emit(serverEvent("text_delta", { text: "还没有说完" }));
    ws.status.value = "disconnected";
    await nextTick();

    expect(chat.isGenerating.value).toBe(false);
    expect(chat.messages.value.some((message) => message.streaming)).toBe(false);
    expect(chat.messages.value.at(-1)).toMatchObject({
      role: "error",
      content: "[连接中断] 连接已断开，本轮已中断",
    });
  });

  it("短暂重连时续传当前回合并忽略重复事件", async () => {
    chat.sendText("继续");
    const runId = textInput(ws.sent)?.request_id;
    expect(runId).toBeTruthy();

    ws.emit(serverEvent("run_started", {}, { request_id: runId!, seq: 1 }));
    ws.emit(serverEvent("text_delta", { text: "前半" }, { request_id: runId!, seq: 2 }));

    ws.status.value = "reconnecting";
    await nextTick();
    expect(chat.isGenerating.value).toBe(true);
    expect(chat.messages.value.some((message) => message.role === "error")).toBe(false);

    ws.status.value = "connected";
    await nextTick();
    expect(ws.sent.at(-1)).toMatchObject({
      type: "resume_run",
      request_id: runId,
      data: { after_seq: 2 },
    });

    ws.emit(serverEvent("text_delta", { text: "前半" }, { request_id: runId!, seq: 2 }));
    ws.emit(serverEvent("text_delta", { text: "后半" }, { request_id: runId!, seq: 3 }));
    expect(chat.messages.value.find((message) => message.role === "assistant")).toMatchObject({
      content: "前半后半",
      streaming: true,
    });
  });

  it("显示后端停机原因，并避免断线时重复追加中断提示", async () => {
    ws.emit(serverEvent("run_started", {}));
    ws.emit(
      serverEvent("server_shutdown", {
        message: "后端即将关闭：桌面端请求关闭",
      }),
    );
    ws.status.value = "disconnected";
    await nextTick();

    const errors = chat.messages.value.filter((message) => message.role === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.content).toContain("桌面端请求关闭");
    expect(chat.isGenerating.value).toBe(false);
  });

  it("把模型错误转成可展示的错误气泡", () => {
    ws.emit(
      serverEvent("error", {
        code: "model_error",
        message: "upstream timeout",
      }),
    );

    expect(chat.messages.value.at(-1)?.content).toBe(
      "[model_error] 模型暂时不可用（upstream timeout）",
    );
  });
});
