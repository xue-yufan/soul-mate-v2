import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./splitter.js";

describe("SentenceSplitter", () => {
  it("streams complete Chinese sentences and flushes the tail", () => {
    const splitter = new SentenceSplitter({
      sentence_min_len: 2,
      sentence_max_len: 12,
    });
    expect(splitter.feed("你好。今")).toEqual(["你好。"]);
    expect(splitter.feed("天很好！")).toEqual(["今天很好！"]);
    expect(splitter.flush()).toEqual([]);
  });

  it("does not cut a decimal point", () => {
    const splitter = new SentenceSplitter({
      sentence_min_len: 1,
      sentence_max_len: 50,
    });
    expect(splitter.feed("价格是 3.14。")).toEqual(["价格是 3.14。"]);
  });
});
