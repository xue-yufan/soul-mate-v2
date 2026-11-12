export const DEFAULT_EMOTION = "neutral";
export const VALID_EMOTIONS = new Set([
  "neutral",
  "happy",
  "sad",
  "surprised",
  "shy",
  "thinking",
  "angry",
]);

const EMOTION_RE = /^\s*<emotion>\s*([a-zA-Z]+)\s*<\/emotion>\s*\n?/i;
const SALVAGE_RE =
  /^\s*<\s*emotion\s*>\s*([a-zA-Z]+)\s*(?:<\/[a-zA-Z]*>?)?\s*\n?/i;

function normalize(raw: string): string {
  const value = raw.toLowerCase();
  return VALID_EMOTIONS.has(value) ? value : DEFAULT_EMOTION;
}

export function parseEmotionTag(text: string): {
  emotion: string | null;
  consumed: number;
} {
  const match = EMOTION_RE.exec(text);
  if (!match) {
    return { emotion: null, consumed: 0 };
  }
  return { emotion: normalize(match[1] ?? ""), consumed: match[0].length };
}

export function salvageEmotionPrefix(text: string): {
  emotion: string | null;
  consumed: number;
} {
  const match = SALVAGE_RE.exec(text);
  if (!match) {
    return { emotion: null, consumed: 0 };
  }
  return { emotion: normalize(match[1] ?? ""), consumed: match[0].length };
}

export function stripEmotionPrefix(text: string): string {
  const parsed = salvageEmotionPrefix(text);
  return parsed.emotion === null ? text : text.slice(parsed.consumed);
}

export function isEmotionPrefix(text: string): boolean {
  const openTag = "<emotion>";
  const closeTag = "</emotion>";
  let index = 0;

  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  if (index === text.length) {
    return true;
  }

  for (const expected of openTag) {
    if (index >= text.length) {
      return true;
    }
    if (text[index]?.toLowerCase() !== expected) {
      return false;
    }
    index += 1;
  }

  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }

  let letters = 0;
  while (
    index < text.length &&
    /[a-zA-Z]/.test(text[index] ?? "")
  ) {
    letters += 1;
    index += 1;
  }
  if (index === text.length) {
    return true;
  }
  if (letters === 0) {
    return false;
  }

  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  if (index === text.length) {
    return true;
  }

  for (const expected of closeTag) {
    if (index >= text.length) {
      return true;
    }
    if (text[index]?.toLowerCase() !== expected) {
      return false;
    }
    index += 1;
  }

  return text.slice(index).trim() === "";
}

export const EMOTION_INSTRUCTION = `【输出格式】
每次回复必须以情绪标签开头，格式严格如下：
<emotion>happy</emotion>
正文……

可选值（只能选一个）：
- neutral   平静
- happy     开心
- sad       难过
- surprised 惊讶
- shy       害羞
- thinking  思考
- angry     生气

标签必须完整、必须换行、必须放在正文之前。不要输出其他说明。`;
