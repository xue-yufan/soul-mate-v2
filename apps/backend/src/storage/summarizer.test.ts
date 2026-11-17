import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  ModelPort,
  ModelStreamOptions,
} from "@soul-mate/agent-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../config/settings.js";
import { Database } from "./database.js";
import {
  estimateSummaryTokens,
  RollingSummaryService,
} from "./summarizer.js";

const temporaryDirectories: string[] = [];

function testContext(): {
  settings: ReturnType<typeof loadSettings>;
  database: Database;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-summary-"));
  temporaryDirectories.push(directory);
  const settings = loadSettings();
  settings.paths = {
    ...settings.paths,
    data_dir: directory,
    sqlite_path: path.join(directory, "soul_mate.db"),
    log_dir: path.join(directory, "logs"),
    log_file: path.join(directory, "logs", "backend.log"),
    chroma_dir: path.join(directory, "chroma"),
    documents_dir: path.join(directory, "documents"),
  };
  settings.logging.level = "silent";
  settings.agent.history_turns = 6;
  settings.agent.summary_trigger_tokens = 1;
  settings.agent.summary_keep_recent_turns = 1;
  return { settings, database: new Database(settings) };
}

function addTurn(
  database: Database,
  index: number,
  assistantText = `助手回复${index}`,
): void {
  database.insertUserMessage("default", `用户消息${index}`);
  database.persistAgentMessages(
    "default",
    [{ role: "assistant", content: assistantText }],
    "test-model",
    1,
    1,
    { value: null },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("rolling conversation summary", () => {
  it("summarizes only messages older than the retained turns", async () => {
    const { settings, database } = testContext();
    const prompts: ChatMessage[][] = [];
    const model: ModelPort = {
      async *stream(
        messages: readonly ChatMessage[],
        _options?: ModelStreamOptions,
      ) {
        prompts.push(messages.map((message) => ({ ...message })));
        yield { delta: `滚动摘要-${prompts.length}` };
      },
    };
    const summary = new RollingSummaryService(settings, model, database);

    try {
      for (let index = 1; index <= 4; index += 1) addTurn(database, index);

      const first = await summary.maybeSummarize("default");
      expect(first).toMatchObject({
        summary: "滚动摘要-1",
        summarizedMessages: 6,
      });
      const prompt = prompts[0]?.map((message) => message.content).join("\n") ?? "";
      expect(prompt).toContain("用户消息1");
      expect(prompt).toContain("助手回复3");
      expect(prompt).not.toContain("用户消息4");

      const state = database.loadSummaryState("default");
      expect(state.summary).toBe("滚动摘要-1");
      expect(state.summarizedThroughRowId).toBeGreaterThan(0);

      await expect(summary.maybeSummarize("default")).resolves.toBeNull();

      addTurn(database, 5);
      const second = await summary.maybeSummarize("default");
      expect(second).toMatchObject({
        summary: "滚动摘要-2",
        summarizedMessages: 2,
      });
      expect(prompts[1]?.map((message) => message.content).join("\n")).toContain(
        "已有摘要",
      );
      expect(
        prompts[1]?.map((message) => message.content).join("\n"),
      ).toContain("用户消息4");
    } finally {
      await summary.close();
      database.close();
    }
  });

  it("keeps the existing summary when generation fails", async () => {
    const { settings, database } = testContext();
    database.saveSummary("default", "原有摘要", 0);
    const model: ModelPort = {
      async *stream() {
        throw new Error("模型不可用");
      },
    };
    const summary = new RollingSummaryService(settings, model, database);

    try {
      for (let index = 1; index <= 3; index += 1) addTurn(database, index);
      await expect(summary.maybeSummarize("default")).resolves.toBeNull();
      expect(database.loadSummaryState("default")).toMatchObject({
        summary: "原有摘要",
        summarizedThroughRowId: 0,
      });
    } finally {
      await summary.close();
      database.close();
    }
  });

  it("uses the original character-based token estimate", () => {
    expect(
      estimateSummaryTokens([
        { content: "1234" },
        { content: "56" },
      ]),
    ).toBe(3);
  });
});
