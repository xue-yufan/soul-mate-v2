import { describe, expect, it } from "vitest";
import { parsePermissionReply } from "./replies.js";

describe("natural language permission replies", () => {
  it.each(["可以", "好，准了", "去吧", "OK", "没问题"])(
    "accepts %s",
    (text) => {
      expect(parsePermissionReply(text)).toBe(true);
    },
  );

  it.each(["不可以", "不必了", "算了", "不要", "no"])(
    "rejects %s",
    (text) => {
      expect(parsePermissionReply(text)).toBe(false);
    },
  );

  it("keeps ambiguous replies unresolved", () => {
    expect(parsePermissionReply("让我再想想")).toBeNull();
    expect(parsePermissionReply("可以是可以，但还是不必了")).toBe(false);
  });
});
