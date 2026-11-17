import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResumableRunRegistry,
  RUN_DISCONNECT_GRACE_MS,
  RUN_RETENTION_MS,
} from "./runs.js";

describe("ResumableRunRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("replays events after the last acknowledged sequence", () => {
    const registry = new ResumableRunRegistry();
    const controller = new AbortController();
    registry.start({
      requestId: "run-1",
      sessionId: "default",
      clientId: "client-1",
      controller,
    });
    registry.record("run-1", "run_started", {});
    registry.record("run-1", "text_delta", { text: "你好" });

    const resumed = registry.resume("run-1", "client-1", 1);
    expect(resumed).toMatchObject({ active: true, sessionId: "default" });
    expect(resumed?.events).toHaveLength(1);
    expect(resumed?.events[0]).toMatchObject({
      seq: 2,
      type: "text_delta",
      data: { text: "你好" },
    });
  });

  it("keeps a disconnected run alive during the grace period", () => {
    const registry = new ResumableRunRegistry();
    const controller = new AbortController();
    registry.start({
      requestId: "run-1",
      sessionId: "default",
      clientId: "client-1",
      controller,
    });

    registry.markClientDisconnected("client-1");
    vi.advanceTimersByTime(RUN_DISCONNECT_GRACE_MS - 1);
    expect(controller.signal.aborted).toBe(false);
    expect(registry.resume("run-1", "client-1", 0)?.active).toBe(true);

    registry.markClientDisconnected("client-1");
    vi.advanceTimersByTime(RUN_DISCONNECT_GRACE_MS);
    expect(controller.signal.aborted).toBe(true);
    const expired = registry.resume("run-1", "client-1", 0);
    expect(expired?.active).toBe(false);
    expect(expired?.events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "connection_lost" },
    });
  });

  it("retains terminal events for late reconnects, then removes them", () => {
    const registry = new ResumableRunRegistry();
    const controller = new AbortController();
    registry.start({
      requestId: "run-1",
      sessionId: "default",
      clientId: "client-1",
      controller,
    });
    registry.record("run-1", "run_finished", {});
    registry.finish("run-1");

    expect(registry.resume("run-1", "client-1", 0)?.active).toBe(false);
    vi.advanceTimersByTime(RUN_RETENTION_MS);
    expect(registry.size).toBe(0);
  });
});
