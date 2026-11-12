export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function tokens(text: string): string[] {
  const normalized = normalizeText(text);
  const result = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2) result.add(word);
  }
  const cjk = normalized.replace(/[^\p{Script=Han}]/gu, "");
  for (let i = 0; i < cjk.length - 1; i += 1) {
    result.add(cjk.slice(i, i + 2));
  }
  if (cjk.length === 1) result.add(cjk);
  return [...result];
}

export function lexicalScore(query: string, text: string): number {
  const q = tokens(query);
  const t = new Set(tokens(text));
  if (q.length === 0 || t.size === 0) return 0;
  let overlap = 0;
  for (const token of q) {
    if (t.has(token)) overlap += 1;
  }
  const coverage = overlap / q.length;
  const density = overlap / Math.max(1, Math.min(t.size, q.length * 2));
  return Math.min(1, coverage * 0.8 + density * 0.2);
}

export function timeDecay(createdAt: string, halfLifeDays: number): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 1;
  const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
  return 0.5 ** (ageDays / Math.max(1, halfLifeDays));
}
