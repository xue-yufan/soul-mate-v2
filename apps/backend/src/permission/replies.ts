const NEGATIVE_FRAGMENTS = [
  "不可以",
  "不行",
  "不要",
  "不必",
  "不用",
  "不准",
  "不好",
  "算了",
  "拒绝",
  "取消",
  "停下",
  "先别",
  "别去",
  "别动",
  "no",
  "nope",
];

const POSITIVE_EXACT = new Set([
  "可以",
  "好",
  "好的",
  "好呀",
  "行",
  "准了",
  "去吧",
  "继续",
  "同意",
  "没问题",
  "当然",
  "是的",
  "对",
  "嗯",
  "嗯嗯",
  "ok",
  "okay",
  "yes",
]);

const POSITIVE_FRAGMENTS = [
  "可以",
  "好啊",
  "好呀",
  "准了",
  "去吧",
  "继续",
  "同意",
  "没问题",
];

export function parsePermissionReply(text: string): boolean | null {
  const normalized = text
    .replace(/[\s，。！？、,.!?：:；;"'“”‘’]/g, "")
    .toLowerCase();
  if (!normalized) return null;
  if (NEGATIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return false;
  }
  if (POSITIVE_EXACT.has(normalized)) return true;
  if (POSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  return null;
}
