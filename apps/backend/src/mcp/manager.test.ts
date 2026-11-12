import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ToolCallContext,
  ToolHostEvent,
} from "@soul-mate/agent-contracts";
import { RequestToolHost } from "../agent/tool-host.js";
import { backendRoot, loadSettings } from "../config/settings.js";
import { PendingRegistry } from "../permission/pending.js";
import { Persona } from "../persona/index.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { CameraBroker } from "../vision/camera-broker.js";
import { McpManager } from "./manager.js";

const gateway = path.resolve(
  backendRoot(),
  "../../.tmp-cargo-target/release",
  process.platform === "win32"
    ? "soul-mate-mcp-rust.exe"
    : "soul-mate-mcp-rust",
);
const available = fs.existsSync(gateway);

describe.runIf(available)("McpManager", () => {
  it("通过 Rust 网关发现并调用 stdio MCP 工具", async () => {
    const settings = loadSettings();
    settings.features.tools = true;
    settings.features.mcp = true;
    settings.mcp.connect_timeout_s = 5;
    settings.mcp.call_timeout_s = 5;
    settings.mcp.max_tools = 10;
    settings.mcp.servers = [
      {
        id: "mock",
        enabled: true,
        transport: "stdio",
        command: gateway,
        args: ["--mock-mcp-server"],
        env: {},
        cwd: null,
        tool_allowlist: ["echo", "slow"],
      },
    ];
    const manager = new McpManager(settings);
    try {
      await manager.start();
      expect(manager.status()).toMatchObject({
        enabled: true,
        toolCount: 2,
        servers: [
          {
            id: "mock",
            connected: true,
            toolCount: 2,
          },
        ],
      });
      const echo = manager
        .tools()
        .find((tool) => tool.name === "mcp__mock__echo");
      expect(echo).toMatchObject({
        riskLevel: "confirm",
        confirmKey: "mcp_read",
      });
      const context = {
        settings,
        sessionId: "session",
        requestId: "request",
        signal: new AbortController().signal,
      } as ToolExecutionContext;
      const result = await echo!.run({ text: "你好" }, context);
      expect(result).toMatchObject({
        ok: true,
        content: "echo:你好",
      });

      settings.permission.overrides.mcp_read = "allow";
      const host = new RequestToolHost(
        settings,
        new Persona(settings.persona.file),
        new PendingRegistry(),
        { hasCameraClient: () => false } as CameraBroker,
        manager,
      );
      const toolContext: ToolCallContext = {
        requestId: "host-request",
        sessionId: "session",
        expert: "chat",
        signal: context.signal,
      };
      const definitions = await host.listTools(toolContext);
      expect(definitions.map((tool) => tool.name)).toContain("mcp__mock__echo");
      const events: ToolHostEvent[] = [];
      for await (const event of host.execute(
        {
          id: "tool-call",
          name: "mcp__mock__echo",
          arguments: JSON.stringify({ text: "宿主" }),
        },
        toolContext,
      )) {
        events.push(event);
      }
      expect(events.map((event) => event.type)).toEqual([
        "tool_call_started",
        "tool_result",
      ]);
      expect(events[1]).toMatchObject({
        type: "tool_result",
        data: { ok: true, content: "echo:宿主" },
      });

      const slow = manager
        .tools()
        .find((tool) => tool.name === "mcp__mock__slow");
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("测试取消 MCP 调用")), 100);
      const cancelled = await slow!.run(
        {},
        {
          ...context,
          signal: controller.signal,
        },
      );
      expect(cancelled.ok).toBe(false);
      expect(cancelled.error).toContain("测试取消 MCP 调用");
    } finally {
      await manager.close();
    }
  }, 30_000);
});
