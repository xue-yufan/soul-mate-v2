import type { ChatMessage, ModelPort } from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";
import type {
  Database,
  SummaryMessage,
  SummaryState,
} from "./database.js";

const MAX_SUMMARY_MESSAGES = 200;
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_SUMMARY_CHARS = 1_600;

export interface RollingSummaryUpdate {
  summary: string;
  summarizedThroughRowId: number;
  summarizedMessages: number;
  estimatedRecentTokens: number;
}

interface SummaryTranscript {
  text: string;
  summarizedThroughRowId: number;
  summarizedMessages: number;
}

export class RollingSummaryService {
  private readonly active = new Map<
    string,
    Promise<RollingSummaryUpdate | null>
  >();
  private readonly controller = new AbortController();
  private closed = false;

  constructor(
    private readonly settings: Settings,
    private readonly model: ModelPort,
    private readonly db: Database,
  ) {}

  maybeSummarize(sessionId: string): Promise<RollingSummaryUpdate | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.active.has(sessionId)) return Promise.resolve(null);

    const task = this.run(sessionId).finally(() => {
      if (this.active.get(sessionId) === task) {
        this.active.delete(sessionId);
      }
    });
    this.active.set(sessionId, task);
    return task;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(new Error("滚动摘要服务正在关闭"));
    await Promise.allSettled([...this.active.values()]);
    this.active.clear();
  }

  private async run(sessionId: string): Promise<RollingSummaryUpdate | null> {
    const { history_turns, summary_trigger_tokens, summary_keep_recent_turns } =
      this.settings.agent;
    if (history_turns <= 0 || summary_trigger_tokens <= 0) return null;

    const recent = this.db.loadRecentSummaryMessages(
      sessionId,
      history_turns,
    );
    const estimatedRecentTokens = estimateSummaryTokens(recent);
    if (estimatedRecentTokens < summary_trigger_tokens) return null;

    const state = this.db.loadSummaryState(sessionId);
    const boundary = this.db.summaryKeepBoundary(
      sessionId,
      summary_keep_recent_turns,
    );
    if (boundary === 0) return null;

    const rows = this.db.loadPendingSummaryMessages(
      sessionId,
      state.summarizedThroughRowId,
      boundary,
      MAX_SUMMARY_MESSAGES,
    );
    if (rows.length === 0) return null;

    const transcript = buildTranscript(rows);
    if (!transcript.text) return null;

    const summary = await this.generateSummary(state, transcript.text);
    if (!summary) return null;

    this.db.saveSummary(
      sessionId,
      summary,
      transcript.summarizedThroughRowId,
    );
    console.info(
      `[摘要] 已更新：session=${sessionId}，消息=${transcript.summarizedMessages}，` +
        `截至 rowid=${transcript.summarizedThroughRowId}，字数=${summary.length}`,
    );
    return {
      summary,
      summarizedThroughRowId: transcript.summarizedThroughRowId,
      summarizedMessages: transcript.summarizedMessages,
      estimatedRecentTokens,
    };
  }

  private async generateSummary(
    state: SummaryState,
    transcript: string,
  ): Promise<string | null> {
    const existing = state.summary?.trim() ?? "";
    const prompt =
      (existing ? `【已有摘要】\n${existing}\n\n` : "") +
      `【需要合并的新对话】\n${transcript}`;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你负责维护一段长期对话的滚动摘要。合并已有摘要和新增对话，" +
          "保留用户身份、偏好、重要事实、关键事件、关系变化、决定与未完成事项。" +
          "使用第三人称，不编造信息，不记录敏感凭据，不输出标题或解释。" +
          `只输出更新后的纯文本摘要，控制在 ${MAX_SUMMARY_CHARS} 字以内。`,
      },
      { role: "user", content: prompt },
    ];

    const timeout = AbortSignal.timeout(
      Math.max(10_000, this.settings.agent.run_timeout_s * 1000),
    );
    const signal = AbortSignal.any([this.controller.signal, timeout]);
    let raw = "";
    try {
      for await (const chunk of this.model.stream(messages, { signal })) {
        if (signal.aborted) throw signal.reason;
        raw += chunk.delta ?? "";
      }
    } catch (error) {
      if (!this.closed) {
        console.warn(
          "[摘要] 生成失败，本轮保留原摘要：",
          error instanceof Error ? error.message : String(error),
        );
      }
      return null;
    }
    return normalizeSummary(raw);
  }
}

export function estimateSummaryTokens(
  messages: ReadonlyArray<Pick<SummaryMessage, "content">>,
): number {
  const characters = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  return Math.ceil(characters / 2);
}

export function normalizeSummary(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_SUMMARY_CHARS).trimEnd();
}

function buildTranscript(rows: SummaryMessage[]): SummaryTranscript {
  let text = "";
  let summarizedThroughRowId = 0;
  let summarizedMessages = 0;

  for (const row of rows) {
    const content = row.content.trim();
    if (!content) {
      summarizedThroughRowId = row.rowId;
      continue;
    }

    const label = row.role === "assistant" ? "助手" : "用户";
    const piece = `${label}：${content}`;
    const separator = text ? "\n\n" : "";
    const remaining = MAX_TRANSCRIPT_CHARS - text.length - separator.length;
    if (remaining <= 0) break;
    if (piece.length > remaining && text) break;

    text += separator + piece.slice(0, remaining);
    summarizedThroughRowId = row.rowId;
    summarizedMessages += 1;
    if (piece.length > remaining) break;
  }

  return { text, summarizedThroughRowId, summarizedMessages };
}
