import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});
