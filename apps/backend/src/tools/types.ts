import type {
  RiskLevel,
  ToolDefinition,
} from "@soul-mate/agent-contracts";
import type { Settings } from "../config/settings.js";

export interface ToolExecutionContext {
  settings: Settings;
  sessionId: string;
  requestId: string;
  signal: AbortSignal;
  cameraBroker: import("../vision/camera-broker.js").CameraBroker;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  error: string | null;
  meta: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  run(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export function toolResult(
  ok: boolean,
  content = "",
  error: string | null = null,
  meta: Record<string, unknown> = {},
): ToolResult {
  return { ok, content, error, meta };
}

export function definition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    riskLevel: tool.riskLevel,
    ...(tool.confirmKey ? { confirmKey: tool.confirmKey } : {}),
    ...(tool.displayName ? { displayName: tool.displayName } : {}),
  };
}

export function riskLevel(value: RiskLevel): RiskLevel {
  return value;
}
