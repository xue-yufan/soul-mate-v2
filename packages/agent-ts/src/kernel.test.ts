import { describe, expect, it } from "vitest";
import type {
  AgentRunContext,
  ChatMessage,
  ModelStreamChunk,
  ToolHost,
} from "@soul-mate/agent-contracts";
import { TypeScriptAgentKernel } from "./kernel.js";

class FakeModel {
  calls = 0;
  requests: ChatMessage[][] = [];

  async *stream(
    messages: readonly ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    this.calls += 1;
    this.requests.push(messages.map((message) => ({ ...message })));
    const hasTool = messages.some((message) => message.role === "tool");
    if (!hasTool) {
      yield {
        toolCalls: [
          {
            id: "call-1",
            name: "get_time",
            arguments: "{}",
          },
        ],
      };
      return;
    }
    yield {
      delta: "<emotion>happy</emotion>\n你好。",
      tokensIn: 12,
      tokensOut: 4,
    };
  }
}

class MultiToolFakeModel {
  async *stream(): AsyncIterable<ModelStreamChunk> {
    yield {
      toolCalls: [
        { id: "call-1", name: "get_time", arguments: "{}" },
        { id: "call-2", name: "get_weather", arguments: '{"city":"北京"}' },
      ],
    };
  }
}

const tools: ToolHost = {
  async listTools() {
    return [
      {
        name: "get_time",
        description: "time",
        parameters: { type: "object", properties: {}, required: [] },
        riskLevel: "safe",
      },
    ];
  },
  async *execute(call) {
    yield {
      type: "tool_call_started" as const,
      data: {
        request_id: "r1",
        tool_call_id: call.id,
        tool: call.name,
        args: {},
      },
    };
    yield {
      type: "tool_result" as const,
      data: {
        request_id: "r1",
        tool_call_id: call.id,
        tool: call.name,
        ok: true,
        content: "12:00",
        error: null,
        meta: {},
      },
    };
  },
};

describe("TypeScriptAgentKernel", () => {
  it("forwards an ordinary first text chunk before the stream finishes", async () => {
    const model = {
      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield { delta: "前半" };
        yield { delta: "后半" };
      },
    };
    const emptyTools: ToolHost = {
      async listTools() {
        return [];
      },
      async *execute() {
        return;
      },
    };
    const context: AgentRunContext = {
      model,
      history: {
        async loadRecent() {
          return [];
        },
        async loadSummary() {
          return null;
        },
      },
      recall: {
        async recall() {
          return "";
        },
      },
      tools: emptyTools,
      systemPrompt: "你是测试角色。",
      modelName: "fake",
      historyTurns: 3,
      maxToolSteps: 2,
      runTimeoutMs: 5000,
    };

    const deltas: string[] = [];
    for await (const event of new TypeScriptAgentKernel().run(
      { text: "继续", requestId: "r-first", sessionId: "default" },
      context,
    )) {
      if (event.type === "text_delta") deltas.push(String(event.data.text));
    }

    expect(deltas).toEqual(["前半", "后半"]);
  });

  it("streams emotion and completes a tool round", async () => {
    const model = new FakeModel();
    const context: AgentRunContext = {
      model,
      history: {
        async loadRecent() {
          return [];
        },
        async loadSummary() {
          return "此前讨论过用户的作息。";
        },
      },
      recall: {
        async recall() {
          return "【相关记忆】\n用户的猫叫团子。";
        },
      },
      tools,
      systemPrompt: "你是测试角色。",
      modelName: "fake",
      historyTurns: 3,
      maxToolSteps: 2,
      runTimeoutMs: 5000,
    };

    const events = [];
    for await (const event of new TypeScriptAgentKernel().run(
      { text: "现在几点了", requestId: "r1", sessionId: "default" },
      context,
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "emotion")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "text_delta" && event.data.text === "你好。",
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      const system = request.find((message) => message.role === "system");
      expect(system?.content).toContain("你是测试角色。");
      expect(system?.content).toContain("此前讨论过用户的作息。");
      expect(system?.content).toContain("用户的猫叫团子。");
      expect(system?.content).toContain("【输出格式】");
    }
  });

  it("closes every tool call when one call in the batch is denied", async () => {
    const executed: string[] = [];
    const deniedTools: ToolHost = {
      async listTools() {
        return [
          {
            name: "get_time",
            description: "time",
            parameters: { type: "object", properties: {}, required: [] },
            riskLevel: "confirm",
          },
          {
            name: "get_weather",
            description: "weather",
            parameters: { type: "object", properties: {}, required: [] },
            riskLevel: "confirm",
          },
        ];
      },
      async *execute(call) {
        executed.push(call.id);
        yield {
          type: "tool_call_started" as const,
          data: {
            request_id: "r1",
            tool_call_id: call.id,
            tool: call.name,
            args: {},
          },
        };
        yield {
          type: "tool_denied" as const,
          data: {
            request_id: "r1",
            tool_call_id: call.id,
            tool: call.name,
            reason: "用户拒绝",
          },
        };
      },
    };
    const context: AgentRunContext = {
      model: new MultiToolFakeModel(),
      history: {
        async loadRecent() {
          return [];
        },
        async loadSummary() {
          return null;
        },
      },
      recall: { async recall() { return ""; } },
      tools: deniedTools,
      systemPrompt: "你是测试角色。",
      modelName: "fake",
      historyTurns: 3,
      maxToolSteps: 2,
      runTimeoutMs: 5000,
    };

    const events = [];
    for await (const event of new TypeScriptAgentKernel().run(
      { text: "现在几点", requestId: "r1", sessionId: "default" },
      context,
    )) {
      events.push(event);
    }

    const finished = events.at(-1);
    expect(finished?.type).toBe("run_finished");
    expect(executed).toEqual(["call-1"]);
    const messages = finished?.data.messages as Array<{
      role: string;
      toolCalls?: Array<{ id: string }>;
      toolCallId?: string;
    }>;
    expect(messages.find((message) => message.role === "assistant")?.toolCalls).toHaveLength(2);
    expect(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-1", "call-2"]);
  });
});
