import { describe, expect, it } from "vitest";
import { PendingRegistry } from "./pending.js";

describe("PendingRegistry owners", () => {
  it("resolves only the pending confirmation owned by a connection", async () => {
    const registry = new PendingRegistry();
    const first = registry.waitFor("first", 5_000, undefined, "connection-a");
    const second = registry.waitFor("second", 5_000, undefined, "connection-b");

    expect(registry.hasOwner("connection-a")).toBe(true);
    expect(registry.resolveForOwner("connection-a", true)).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(registry.hasOwner("connection-b")).toBe(true);
    expect(registry.resolveForOwner("connection-b", false)).toBe(true);
    await expect(second).resolves.toBe(false);

    registry.clear();
  });

  it("rejects an owner without a pending confirmation", () => {
    const registry = new PendingRegistry();
    expect(registry.hasOwner("missing")).toBe(false);
    expect(registry.resolveForOwner("missing", true)).toBe(false);
  });

  it("does not accept an explicit confirmation from another connection", async () => {
    const registry = new PendingRegistry();
    const pending = registry.waitFor(
      "confirm-owner",
      5_000,
      undefined,
      "connection-a",
    );
    expect(registry.resolve("confirm-owner", true, "connection-b")).toBe(false);
    expect(registry.resolve("confirm-owner", true, "connection-a")).toBe(true);
    await expect(pending).resolves.toBe(true);
  });
});
