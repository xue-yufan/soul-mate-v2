import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

class PausableFakeModel {
  private releaseGate!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate();
  }

  async *stream(
    messages: readonly ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    if (system.includes("只把用户")) {
      yield { delta: "chat" };
      return;
    }
    yield { delta: "前半" };
    await this.gate;
    yield { delta: "后半", tokensIn: 20, tokensOut: 8 };
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

  it("reconnects with the same client and replays missing run events", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-resume-"));
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
    settings.agent.kernel = "typescript";
    settings.features.memory = false;
    settings.features.rag = false;
    const runtime = new Runtime(settings);
    const model = new PausableFakeModel();
    runtime.model = model as never;
    const app = await buildApp(runtime);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(async () => {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    });

    const wsUrl = base.replace("http", "ws") + "/ws";
    const clientId = "resume-test-client-0001";
    const first = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      first.once("open", () => resolve());
      first.once("error", reject);
    });
    const firstEvents: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for first text delta: ${JSON.stringify(firstEvents)}`,
            ),
          ),
        5_000,
      );
      first.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        firstEvents.push(event);
        if (event.type === "client_hello_ack") {
          first.send(
            JSON.stringify({
              v: 1,
              type: "text_input",
              request_id: "resume-run",
              data: { text: "请继续" },
            }),
          );
        }
        if (event.type === "text_delta") {
          clearTimeout(timeout);
          resolve();
        }
      });
      first.once("error", reject);
      first.send(
        JSON.stringify({
          v: 1,
          type: "client_hello",
          request_id: "hello-1",
          data: { capabilities: [], client_id: clientId },
        }),
      );
    });
    const lastReceivedSeq = Math.max(
      ...firstEvents
        .map((event) => Number(event.seq ?? 0))
        .filter((seq) => Number.isInteger(seq)),
    );
    first.close();
    await new Promise((resolve) => first.once("close", resolve));

    model.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      second.once("open", () => resolve());
      second.once("error", reject);
    });
    const replayed: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for resumed run")),
        5_000,
      );
      second.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        replayed.push(event);
        if (event.type === "client_hello_ack") {
          second.send(
            JSON.stringify({
              v: 1,
              type: "resume_run",
              request_id: "resume-run",
              data: { after_seq: lastReceivedSeq },
            }),
          );
        }
        if (event.type === "run_finished") {
          clearTimeout(timeout);
          resolve();
        }
      });
      second.once("error", reject);
      second.send(
        JSON.stringify({
          v: 1,
          type: "client_hello",
          request_id: "hello-2",
          data: { capabilities: [], client_id: clientId },
        }),
      );
    });
    second.close();

    expect(
      replayed
        .filter((event) => event.type === "text_delta")
        .map((event) => (event.data as { text: string }).text)
        .join(""),
    ).toContain("后半");
    expect(replayed.some((event) => event.type === "text_delta" && (event.data as { text: string }).text === "前半")).toBe(false);
  }, 10_000);

  it("transcribes a 16 kHz WAV through the configured local engine", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-asr-ws-"));
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
    settings.features.voice = true;
    settings.voice.engine = "whisper";
    settings.voice.command = process.execPath;
    settings.voice.args = [
      fileURLToPath(new URL("../voice/asr.fixture.mjs", import.meta.url)),
      "--output",
      "{output}",
    ];
    const runtime = new Runtime(settings);
    const app = await buildApp(runtime);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(async () => {
      await app.close();
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    });

    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const socket = new WebSocket(base.replace("http", "ws") + "/ws");
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for transcription")),
          5_000,
        );
        socket.on("open", () => {
          socket.send(
            JSON.stringify({
              v: 1,
              type: "audio_input",
              request_id: "voice-run",
              data: {
                audio: makeWav(1_600).toString("base64"),
                mime_type: "audio/wav",
                sample_rate: 16_000,
                duration_ms: 100,
              },
            }),
          );
        });
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (event.type === "transcription_result") {
            clearTimeout(timeout);
            socket.close();
            resolve(event.data as Record<string, unknown>);
          }
          if (event.type === "transcription_error") {
            clearTimeout(timeout);
            socket.close();
            reject(new Error(JSON.stringify(event.data)));
          }
        });
        socket.on("error", reject);
      },
    );

    expect(result).toMatchObject({
      text: "你好，这是本地语音识别。",
      engine: "whisper.cpp",
    });
  });
});

function makeWav(samples: number): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
