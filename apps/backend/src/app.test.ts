import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentKernel } from "@soul-mate/agent-contracts";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "./app.js";
import { loadSettings } from "./config/settings.js";
import { Runtime } from "./runtime.js";

function testRuntime(): { runtime: Runtime; temp: string } {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-auth-"));
  const settings = loadSettings();
  settings.paths = {
    ...settings.paths,
    data_dir: temp,
    sqlite_path: path.join(temp, "soul_mate.db"),
    log_dir: path.join(temp, "logs"),
    log_file: path.join(temp, "logs", "backend.log"),
    chroma_dir: path.join(temp, "chroma"),
    documents_dir: path.join(temp, "documents"),
  };
  settings.logging.level = "silent";
  return {
    runtime: new Runtime(settings, { localToken: "test-token" }),
    temp,
  };
}

describe("local API security", () => {
  it("requires the ephemeral token and accepts empty DELETE bodies", async () => {
    const { runtime, temp } = testRuntime();
    const app = await buildApp(runtime);
    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/health",
      });
      expect(unauthorized.statusCode).toBe(401);

      const liveness = await app.inject({
        method: "GET",
        url: "/healthz",
      });
      expect(liveness.statusCode).toBe(200);

      const authorized = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer test-token" },
      });
      expect(authorized.statusCode).toBe(200);
      const health = authorized.json() as {
        checks: {
          modules: Record<string, { state: string; message: string }>;
        };
      };
      expect(health.checks.modules.database?.state).toBe("ready");
      expect(["ready", "degraded"]).toContain(
        health.checks.modules.model?.state,
      );
      expect(health.checks.modules.model?.message).toBeTruthy();
      expect(["disabled", "degraded", "ready", "missing"]).toContain(
        health.checks.modules.embedding?.state,
      );
      expect(health.checks.modules.embedding?.message).toBeTruthy();

      const backup = await app.inject({
        method: "GET",
        url: "/data/backup",
        headers: { authorization: "Bearer test-token" },
      });
      expect(backup.statusCode).toBe(200);
      expect(backup.headers["content-type"]).toContain(
        "application/vnd.sqlite3",
      );
      expect(Number(backup.headers["content-length"])).toBeGreaterThan(0);

      let shutdownReason = "";
      runtime.onShutdownRequested((reason) => {
        shutdownReason = reason;
      });
      const shutdown = await app.inject({
        method: "POST",
        url: "/system/shutdown",
        headers: { authorization: "Bearer test-token" },
      });
      expect(shutdown.statusCode).toBe(200);
      expect(shutdownReason).toContain("桌面端");

      const cleared = await app.inject({
        method: "DELETE",
        url: "/history/messages",
        headers: { authorization: "Bearer test-token" },
      });
      expect(cleared.statusCode).toBe(200);

      runtime.database.insertUserMessage("default", "请重复这一轮");
      const lastAssistantId = { value: null as string | null };
      runtime.database.persistAgentMessages(
        "default",
        [{ role: "assistant", content: "旧回答" }],
        "test-model",
        1,
        1,
        lastAssistantId,
      );
      const regenerated = await app.inject({
        method: "POST",
        url: "/history/regenerate",
        headers: { authorization: "Bearer test-token" },
      });
      expect(regenerated.statusCode).toBe(200);
      expect(regenerated.json()).toMatchObject({
        text: "请重复这一轮",
        deleted: 2,
      });
      expect(runtime.database.countMessages("default")).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("authenticates WebSocket messages before accepting commands", async () => {
    const { runtime, temp } = testRuntime();
    const app = await buildApp(runtime);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(base.replace("http", "ws") + "/ws");
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("timed out waiting for authenticated pong"));
        }, 3000);
        socket.on("open", () => {
          socket.send(
            JSON.stringify({
              v: 1,
              type: "auth",
              request_id: "auth",
              data: { token: "test-token" },
            }),
          );
          socket.send(
            JSON.stringify({
              v: 1,
              type: "ping",
              request_id: "ping",
            }),
          );
        });
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as {
            type: string;
            data: Record<string, unknown>;
          };
          events.push(event);
          if (event.type === "pong") {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        });
        socket.on("error", reject);
      });
      expect(events.at(-1)?.type).toBe("pong");
    } finally {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("accepts a natural permission reply and broadcasts shutdown", async () => {
    const { runtime, temp } = testRuntime();
    runtime.settings.features.tools = true;
    runtime.settings.features.vision = false;
    runtime.settings.features.tts = false;
    runtime.settings.features.memory = false;
    runtime.settings.features.rag = false;
    runtime.settings.permission.default = "confirm";
    const target = path.join(temp, "note.txt");
    fs.writeFileSync(target, "可以读到的内容", "utf-8");

    const kernel: AgentKernel = {
      id: "test-confirm-kernel",
      contractVersion: 1,
      async *run(input, context, signal) {
        yield { type: "run_started", data: {} };
        for await (const event of context.tools.execute(
          {
            id: "call-1",
            name: "read_file",
            arguments: JSON.stringify({ path: target }),
          },
          {
            requestId: input.requestId,
            sessionId: input.sessionId,
            expert: "info",
            signal: signal ?? new AbortController().signal,
          },
        )) {
          yield event;
        }
        yield {
          type: "run_finished",
          data: {
            messages: [],
            tokens_in: 1,
            tokens_out: 1,
            model: "test-model",
          },
        };
      },
      async close() {},
    };
    runtime.kernel = kernel;

    const app = await buildApp(runtime);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(base.replace("http", "ws") + "/ws");
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("timed out waiting for natural permission flow"));
        }, 5000);
        let replied = false;
        socket.on("open", () => {
          socket.send(
            JSON.stringify({
              v: 1,
              type: "auth",
              request_id: "auth",
              data: { token: "test-token" },
            }),
          );
          socket.send(
            JSON.stringify({
              v: 1,
              type: "text_input",
              request_id: "request-1",
              data: { text: "请读取文件" },
            }),
          );
        });
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as {
            type: string;
            data: Record<string, unknown>;
          };
          events.push(event);
          if (event.type === "tool_confirm_request" && !replied) {
            replied = true;
            socket.send(
              JSON.stringify({
                v: 1,
                type: "text_input",
                request_id: "permission-reply",
                data: { text: "可以" },
              }),
            );
          }
          if (event.type === "run_finished") {
            runtime.beginShutdown("测试关闭");
          }
          if (event.type === "server_shutdown") {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        });
        socket.on("error", reject);
      });

      expect(events.some((event) => event.type === "tool_confirm_request")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "tool_result")).toBe(true);
      expect(events.at(-1)?.type).toBe("server_shutdown");
      const persisted = runtime.database.listMessages("default", 100, 0);
      expect(
        persisted.some(
          (message) =>
            message.role === "assistant" &&
            String(message.content).includes("note.txt"),
        ),
      ).toBe(true);
      expect(
        persisted.some(
          (message) =>
            message.role === "user" && message.content === "可以",
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("notifies memory degradation once per WebSocket connection", async () => {
    const { runtime, temp } = testRuntime();
    runtime.settings.features.memory = true;
    runtime.settings.features.rag = false;
    runtime.settings.features.tools = false;
    runtime.settings.features.tts = false;
    runtime.settings.paths.embed_model_dir = null;
    const kernel: AgentKernel = {
      id: "test-memory-kernel",
      contractVersion: 1,
      async *run() {
        yield { type: "run_started", data: {} };
        yield {
          type: "run_finished",
          data: {
            messages: [],
            tokens_in: 1,
            tokens_out: 1,
            model: "test-model",
          },
        };
      },
      async close() {},
    };
    runtime.kernel = kernel;

    const app = await buildApp(runtime);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(base.replace("http", "ws") + "/ws");
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("timed out waiting for memory warning"));
        }, 5000);
        let finishedRuns = 0;
        socket.on("open", () => {
          socket.send(
            JSON.stringify({
              v: 1,
              type: "auth",
              request_id: "auth",
              data: { token: "test-token" },
            }),
          );
          socket.send(
            JSON.stringify({
              v: 1,
              type: "text_input",
              request_id: "memory-1",
              data: { text: "第一次" },
            }),
          );
        });
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as {
            type: string;
            data: Record<string, unknown>;
          };
          events.push(event);
          if (event.type === "run_finished") {
            finishedRuns += 1;
            if (finishedRuns === 1) {
              setTimeout(() => {
                socket.send(
                  JSON.stringify({
                    v: 1,
                    type: "text_input",
                    request_id: "memory-2",
                    data: { text: "第二次" },
                  }),
                );
              }, 20);
            } else {
              runtime.beginShutdown("测试关闭");
            }
          }
          if (event.type === "server_shutdown") {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        });
        socket.on("error", reject);
      });

      expect(
        events.filter(
          (event) =>
            event.type === "error" &&
            event.data.code === "memory_unavailable",
        ),
      ).toHaveLength(1);
    } finally {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
