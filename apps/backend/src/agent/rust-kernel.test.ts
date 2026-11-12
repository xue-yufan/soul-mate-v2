import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentRunContext,
  ModelStreamChunk,
  ToolHostEvent,
} from "@soul-mate/agent-contracts";
import { RustSidecarKernel } from "./rust-kernel.js";
import { backendRoot } from "../config/settings.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "rust-kernel.fixture.mjs",
);
const kernels: RustSidecarKernel[] = [];
const nativeExecutable = path.resolve(
  backendRoot(),
  "../../.tmp-cargo-target/release",
  process.platform === "win32"
    ? "soul-mate-agent-rust.exe"
    : "soul-mate-agent-rust",
);

function input(requestId: string, text: string) {
  return {
    text,
    requestId,
    sessionId: `session-${requestId}`,
    currentUserMessageId: `user-${requestId}`,
  };
}

function context(
  modelChunks: ModelStreamChunk[] = [{ delta: "你好" }],
  toolEvents: ToolHostEvent[] = [],
): AgentRunContext {
  return {
    model: {
      async *stream() {
        for (const chunk of modelChunks) {
          yield chunk;
        }
      },
    },
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
    tools: {
      async listTools() {
        return [];
      },
      async *execute() {
        for (const event of toolEvents) {
          yield event;
        }
      },
    },
    systemPrompt: "测试人格",
    modelName: "fake-model",
    historyTurns: 6,
    maxToolSteps: 4,
    runTimeoutMs: 5_000,
  };
}

async function collect(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function kernel(): RustSidecarKernel {
  const instance = new RustSidecarKernel(process.execPath, [fixture]);
  kernels.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(kernels.splice(0).map((instance) => instance.close()));
});

describe("Rust Agent sidecar 宿主协议", () => {
  it.runIf(fs.existsSync(nativeExecutable))(
    "真实 Rust 二进制完成宿主回调和多块文本流",
    async () => {
      const instance = new RustSidecarKernel(nativeExecutable);
      kernels.push(instance);
      const events = await collect(
        instance.run(
          input("native", "天气 Rust 集成"),
          context([{ delta: "<emotion>happy</emotion>你" }, { delta: "好" }]),
        ),
      );

      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.data.text)
          .join(""),
      ).toBe("你好");
      expect(
        events.find((event) => event.type === "emotion")?.data.emotion,
      ).toBe("happy");
      expect(events.at(-1)?.type).toBe("run_finished");
    },
    15_000,
  );

  it("完成握手并接收多路模型流", async () => {
    const instance = kernel();
    const events = await collect(
      instance.run(
        input("stream", "普通聊天"),
        context([{ delta: "第一段" }, { delta: "第二段" }]),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "emotion",
      "text_delta",
      "text_delta",
      "run_finished",
    ]);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.data.text),
    ).toEqual(["第一段", "第二段"]);
  });

  it("并发运行时按 run_id 隔离事件", async () => {
    const instance = kernel();
    const [first, second] = await Promise.all([
      collect(
        instance.run(input("run-a", "并发 A"), context([{ delta: "A" }])),
      ),
      collect(
        instance.run(input("run-b", "并发 B"), context([{ delta: "B" }])),
      ),
    ]);

    expect(first.find((event) => event.type === "text_delta")?.data.text).toBe(
      "A",
    );
    expect(second.find((event) => event.type === "text_delta")?.data.text).toBe(
      "B",
    );
    expect(first.at(-1)?.data.text).toBe("A");
    expect(second.at(-1)?.data.text).toBe("B");
  });

  it("工具宿主的多块事件不会被首块覆盖", async () => {
    const instance = kernel();
    const events = await collect(
      instance.run(
        input("tools", "tools 调用工具"),
        context(
          [],
          [
            {
              type: "tool_call_started",
              data: {
                request_id: "tools",
                tool_call_id: "tools:call",
                tool: "fixture",
                args: {},
              },
            },
            {
              type: "tool_confirm_request",
              data: {
                request_id: "tools",
                tool_call_id: "tools:call",
                confirm_id: "confirm-1",
                tool: "fixture",
                args: {},
                timeout_s: 5,
              },
            },
            {
              type: "tool_result",
              data: {
                request_id: "tools",
                tool_call_id: "tools:call",
                tool: "fixture",
                ok: true,
                content: "完成",
                error: null,
                meta: {},
              },
            },
          ],
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "tool_call_started",
      "tool_confirm_request",
      "tool_result",
      "run_finished",
    ]);
  });

  it("取消后透传取消错误并结束运行", async () => {
    const instance = kernel();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of instance.run(
      input("cancel", "取消测试"),
      context(),
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "run_started") {
        controller.abort(new Error("取消测试"));
      }
    }

    expect(events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "cancelled" },
    });
    expect(events.some((event) => event.type === "run_finished")).toBe(false);
  });

  it("子进程异常退出时唤醒全部运行", async () => {
    const instance = kernel();
    const events = await collect(
      instance.run(input("exit", "exit"), context()),
    );

    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "internal_error" },
    });
  });
});
