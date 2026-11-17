import { describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "./hub.js";

describe("RealtimeHub", () => {
  it("broadcasts the shutdown event to every registered client", () => {
    const hub = new RealtimeHub();
    const first = { id: "first", send: vi.fn(), sendRaw: vi.fn() };
    const second = { id: "second", send: vi.fn(), sendRaw: vi.fn() };
    hub.register(first);
    hub.register(second);

    expect(hub.notifyShutdown("服务即将关闭")).toBe(2);
    expect(first.send).toHaveBeenCalledWith("server_shutdown", {
      message: "服务即将关闭",
    });
    expect(second.send).toHaveBeenCalledWith("server_shutdown", {
      message: "服务即将关闭",
    });

    second.id = "renamed-second";
    hub.replace("second", second);
    expect(hub.current("second")).toBeUndefined();
    expect(hub.current("renamed-second")).toBe(second);

    hub.unregister(first);
    expect(hub.size).toBe(1);
  });
});
