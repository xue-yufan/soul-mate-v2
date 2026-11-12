import type { ModelPort } from "@soul-mate/agent-contracts";

export type Intent = "chat" | "info";

const INFO_PATTERNS = [
  /几[点点]/,
  /现在.*(时间|日期|星期)/,
  /今天.*(星期|几号|日期)/,
  /天气/,
  /气温/,
  /(查一下|搜索|检索|告诉我).*(资料|文档|知识)/,
  /what time|weather|date/i,
];

export function ruleBasedIntent(text: string): Intent | null {
  const trimmed = text.trim();
  if (INFO_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "info";
  }
  return Array.from(trimmed).length < 5 ? "chat" : null;
}

export interface IntentResult {
  intent: Intent;
  tokensIn: number;
  tokensOut: number;
}

export async function classifyIntent(
  model: ModelPort,
  text: string,
  signal: AbortSignal,
): Promise<IntentResult> {
  const ruled = ruleBasedIntent(text);
  if (ruled) {
    return { intent: ruled, tokensIn: 0, tokensOut: 0 };
  }

  let raw = "";
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    for await (const chunk of model.stream(
      [
        {
          role: "system",
          content:
            "只把用户的最后一句话分类为 chat 或 info。闲聊、情绪陪伴、角色扮演输出 chat；查询事实、时间、天气、资料输出 info。只输出一个单词。",
        },
        { role: "user", content: text },
      ],
      { signal },
    )) {
      raw += chunk.delta ?? "";
      tokensIn += chunk.tokensIn ?? 0;
      tokensOut += chunk.tokensOut ?? 0;
      if (raw.trim().length >= 8) {
        break;
      }
    }
  } catch {
    return { intent: "chat", tokensIn, tokensOut };
  }

  return {
    intent: /\binfo\b/i.test(raw) ? "info" : "chat",
    tokensIn,
    tokensOut,
  };
}
