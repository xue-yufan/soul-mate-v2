import type {
  ToolCall,
  ToolCallContext,
  ToolDefinition,
  ToolHost,
  ToolHostEvent,
} from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { Persona } from "../persona/index.js";
import type { PendingRegistry } from "../permission/pending.js";
import type { CameraBroker } from "../vision/camera-broker.js";
import type { OpenCvPreprocessor } from "../vision/opencv.js";
import { builtinTools, lookThroughCameraTool } from "../tools/builtin.js";
import { definition } from "../tools/types.js";

export class RequestToolHost implements ToolHost {
  constructor(
    private readonly settings: Settings,
    private readonly persona: Persona,
    private readonly pending: PendingRegistry,
    private readonly cameraBroker: CameraBroker,
    private readonly mcp: McpManager,
    private readonly pendingOwner?: string,
    private readonly visionPreprocessor?: OpenCvPreprocessor,
  ) {}

  async listTools(context: ToolCallContext): Promise<ToolDefinition[]> {
    if (!this.settings.features.tools) return [];
    const includeVision =
      this.settings.features.vision && this.cameraBroker.hasCameraClient();
    const tools = builtinTools(includeVision);
    const filtered =
      context.expert === "info"
        ? tools
        : tools.filter((tool) => tool.name === "look_through_camera");
    return [...filtered, ...this.mcp.tools()]
      .filter(
        (tool, index, tools) =>
          tools.findIndex((candidate) => candidate.name === tool.name) ===
          index,
      )
      .map(definition);
  }

  async *execute(
    call: ToolCall,
    context: ToolCallContext,
  ): AsyncIterable<ToolHostEvent> {
    const tools = [
      ...builtinTools(
        this.settings.features.vision && this.cameraBroker.hasCameraClient(),
      ),
      ...this.mcp.tools(),
    ];
    const tool = tools.find((item) => item.name === call.name);
    yield {
      type: "tool_call_started",
      data: {
        request_id: context.requestId,
        tool_call_id: call.id,
        tool: call.name,
        args: safeArgs(call.arguments),
      },
    };
    if (!tool) {
      yield {
        type: "tool_result",
        data: {
          request_id: context.requestId,
          tool_call_id: call.id,
          tool: call.name,
          ok: false,
          content: "",
          error: "工具不存在",
          meta: {},
        },
      };
      return;
    }

    const args = safeArgs(call.arguments);
    const decision =
      this.settings.permission.overrides[tool.name] ??
      (tool.confirmKey
        ? this.settings.permission.overrides[tool.confirmKey]
        : undefined) ??
      this.settings.permission.default ??
      (tool.riskLevel === "safe"
        ? "allow"
        : tool.riskLevel === "dangerous"
          ? "deny"
          : "confirm");
    let allowed = decision === "allow";

    if (decision === "confirm") {
      const confirmId = this.pending.createId();
      const timeoutS = this.settings.permission.confirm_timeout_s;
      const allowedPromise = this.pending.waitFor(
        confirmId,
        timeoutS * 1000,
        context.signal,
        this.pendingOwner,
      );
      yield {
        type: "tool_confirm_request",
        data: {
          request_id: context.requestId,
          tool_call_id: call.id,
          confirm_id: confirmId,
          tool: tool.name,
          args,
          timeout_s: timeoutS,
          prompt: this.persona.confirmPrompt(tool.name, args, tool.confirmKey),
        },
      };
      allowed = await allowedPromise;
    }

    if (!allowed) {
      yield {
        type: "tool_denied",
        data: {
          request_id: context.requestId,
          tool_call_id: call.id,
          tool: tool.name,
          reason: decision === "deny" ? "权限设置为拒绝" : "用户拒绝或确认超时",
        },
      };
      return;
    }

    const result = await tool.run(args, {
      settings: this.settings,
      sessionId: context.sessionId,
      requestId: context.requestId,
      signal: context.signal,
      cameraBroker: this.cameraBroker,
      ...(this.visionPreprocessor
        ? { visionPreprocessor: this.visionPreprocessor }
        : {}),
    });
    yield {
      type: "tool_result",
      data: {
        request_id: context.requestId,
        tool_call_id: call.id,
        tool: tool.name,
        ok: result.ok,
        content: result.content,
        error: result.error,
        meta: result.meta,
      },
    };
  }
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export { lookThroughCameraTool };
