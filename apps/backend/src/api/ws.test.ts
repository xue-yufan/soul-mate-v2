import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
  ChatMessage,
  ModelStreamChunk,
} from "@soul-mate/agent-contracts";
import { buildApp } from "../app.js";
import { loadSettings } from "../config/settings.js";
import { Runtime } from "../runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

class StreamingFakeModel {
  async *stream(
    messages: readonly ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    if (system.includes("只把用户")) {
      yield { delta: "chat" };
      return;
    }
    yield {
      delta: "<emotion>shy</emotion>\n你好，阁下。",
      tokensIn: 12,
      tokensOut: 6,
    };
  }
}

describe("WebSocket text_input", () => {
  it("streams a response and persists the turn", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-v2-"));
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
    const runtime = new Runtime(settings);
    runtime.model = new StreamingFakeModel() as never;
    const app = await buildApp(runtime);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(async () => {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(base.replace("http", "ws") + "/ws");
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("timed out waiting for run_finished"));
      }, 5000);
      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "text_input",
            request_id: "test-run",
            data: { text: "你好" },
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
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      });
      socket.on("error", reject);
    });

    expect(events.some((event) => event.type === "emotion")).toBe(true);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.data.text)
        .join(""),
    ).toContain("你好，阁下");

    const historyResponse = await app.inject({
      method: "GET",
      url: "/history/messages",
    });
    const history = historyResponse.json() as {
      total: number;
      items: Array<{ role: string; content: string }>;
    };
    expect(history.total).toBe(2);
    expect(history.items[0]?.role).toBe("user");
    expect(history.items[1]?.role).toBe("assistant");
  });
});
