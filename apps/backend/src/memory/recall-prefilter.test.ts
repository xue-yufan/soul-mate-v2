import { describe, expect, it } from "vitest";
import { prefilterCandidates } from "./service.js";

describe("召回候选预过滤", () => {
  it("仅在大候选集上截断并优先保留词项和 boost 较高的条目", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      lexical: index / 20,
      boost: index === 2 ? 2 : 0,
    }));
    const filtered = prefilterCandidates(candidates, 5);
    expect(filtered).toHaveLength(5);
    expect(filtered[0]?.id).toBe("2");
    expect(filtered.map((item) => item.id)).toContain("19");
  });

  it("候选未超过上限时保持完整结果", () => {
    const candidates = [{ id: "one", lexical: 0 }];
    expect(prefilterCandidates(candidates, 5)).toBe(candidates);
  });
});
