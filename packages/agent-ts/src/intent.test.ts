import { describe, expect, it } from "vitest";
import { ruleBasedIntent } from "./intent.js";

describe("意图规则", () => {
  it("关键词优先于短句规则", () => {
    expect(ruleBasedIntent("天气")).toBe("info");
    expect(ruleBasedIntent("几点")).toBe("info");
  });

  it("无关键词的短消息直接判 chat", () => {
    expect(ruleBasedIntent("你好")).toBe("chat");
    expect(ruleBasedIntent("晚安")).toBe("chat");
  });

  it("较长闲聊仍交给模型分类", () => {
    expect(ruleBasedIntent("今天想和你聊一会儿")).toBeNull();
  });
});
