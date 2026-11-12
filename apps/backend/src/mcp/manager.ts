import crypto from "node:crypto";
import type { ToolDefinition } from "@soul-mate/agent-contracts";
import type { McpServerSettings, Settings } from "../config/settings.js";
import { toolResult, type Tool, type ToolResult } from "../tools/types.js";
import { McpGatewayClient, type GatewayEvent } from "./gateway.js";

interface AnnexAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  serverId: string;
  originalName: string;
  qualifiedName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: AnnexAnnotations;
  confirmKey: string;
}

interface ServerState {
  id: string;
  connected: boolean;
  toolCount: number;
  error: string | null;
}

export interface McpStatus {
  enabled: boolean;
  servers: ServerState[];
  toolCount: number;
}

export class McpManager {
  private gateways = new Map<string, McpGatewayClient>();
  private entries = new Map<string, McpToolInfo>();
  private servers: ServerState[] = [];

  constructor(private readonly settings: Settings) {}

  get enabled(): boolean {
    return this.settings.features.tools && this.settings.features.mcp;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    const valid = this.validServers();
    if (valid.length === 0) {
      console.info("[MCP] 已启用，但没有需要连接的 stdio 服务");
      return;
    }

    const results = await Promise.allSettled(
      valid.map(async (server) => {
        const state: ServerState = {
          id: server.id,
          connected: false,
          toolCount: 0,
          error: null,
        };
        this.servers.push(state);
        const gateway = new McpGatewayClient(this.settings, server, (event) =>
          this.logEvent(event),
        );
        try {
          const rawTools = await gateway.start();
          const allowlist = new Set(server.tool_allowlist);
          const discovered = rawTools
            .map((tool) => normalizeTool(server.id, tool))
            .filter(
              (tool): tool is McpToolInfo =>
                tool !== null &&
                (allowlist.size === 0 || allowlist.has(tool.originalName)),
            );
          for (const tool of discovered) {
            if (!this.entries.has(tool.qualifiedName)) {
              this.entries.set(tool.qualifiedName, tool);
            }
          }
          state.connected = true;
          state.toolCount = discovered.length;
          this.gateways.set(server.id, gateway);
          console.info(
            `[MCP] 服务已连接：${server.id}，工具 ${discovered.length}/${rawTools.length}`,
          );
          return state;
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          console.warn(`[MCP] 服务连接失败：${server.id}：${state.error}`);
          await gateway.close().catch(() => undefined);
          return state;
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[MCP] 服务启动异常：", result.reason);
      }
    }

    const limit = Math.max(1, this.settings.mcp.max_tools);
    if (this.entries.size > limit) {
      const originalCount = this.entries.size;
      const kept = [...this.entries.entries()].slice(0, limit);
      this.entries = new Map(kept);
      console.warn(
        `[MCP] 工具数量超过上限，已从 ${originalCount} 截断为 ${limit}`,
      );
    }
  }

  tools(): Tool[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.qualifiedName,
      description: `来自 MCP 服务 ${entry.serverId}。${entry.description}`,
      parameters: entry.inputSchema,
      riskLevel: "confirm",
      confirmKey: entry.confirmKey,
      displayName: entry.title,
      run: (args, context) => this.callTool(entry, args, context.signal),
    }));
  }

  definitions(): ToolDefinition[] {
    return this.tools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      riskLevel: tool.riskLevel,
      ...(tool.confirmKey ? { confirmKey: tool.confirmKey } : {}),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
    }));
  }

  status(): McpStatus {
    return {
      enabled: this.enabled,
      servers: this.servers.map((server) => ({ ...server })),
      toolCount: this.entries.size,
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.gateways.values()].map((gateway) =>
        gateway.close().catch((error: unknown) => {
          console.warn("[MCP] 网关关闭失败：", error);
        }),
      ),
    );
    this.gateways.clear();
    this.entries.clear();
    this.servers = [];
  }

  private async callTool(
    entry: McpToolInfo,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const gateway = this.gateways.get(entry.serverId);
    if (!gateway) {
      return toolResult(false, "", `MCP 服务不可用：${entry.serverId}`);
    }
    try {
      const result = await gateway.callTool(entry.originalName, args, signal);
      return formatCallResult(
        entry,
        result,
        this.settings.mcp.max_result_chars,
      );
    } catch (error) {
      return toolResult(
        false,
        "",
        error instanceof Error ? error.message : String(error),
        { server: entry.serverId, tool: entry.originalName },
      );
    }
  }

  private validServers(): McpServerSettings[] {
    const seen = new Set<string>();
    const servers: McpServerSettings[] = [];
    for (const server of this.settings.mcp.servers) {
      if (!server.enabled) continue;
      if (!server.id.trim() || seen.has(server.id)) {
        console.warn(`[MCP] 服务 ID 为空或重复，已跳过：${server.id || "空"}`);
        continue;
      }
      if (server.transport !== "stdio") {
        console.warn(
          `[MCP] 当前 Rust 网关只支持 stdio，已跳过：${server.id} (${server.transport})`,
        );
        continue;
      }
      if (!server.command.trim()) {
        console.warn(`[MCP] 服务缺少 command，已跳过：${server.id}`);
        continue;
      }
      seen.add(server.id);
      servers.push(server);
    }
    return servers;
  }

  private logEvent(event: GatewayEvent): void {
    const line = `[MCP/${event.server}] ${event.message}`;
    if (event.stream === "exit" || event.stream === "gateway") {
      console.warn(line);
    } else {
      console.info(line);
    }
  }
}

function normalizeTool(serverId: string, raw: unknown): McpToolInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tool = raw as Record<string, unknown>;
  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  if (!name) return null;
  const schema =
    typeof tool.inputSchema === "object" &&
    tool.inputSchema !== null &&
    !Array.isArray(tool.inputSchema)
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {}, required: [] };
  const annotations =
    typeof tool.annotations === "object" && tool.annotations !== null
      ? (tool.annotations as AnnexAnnotations)
      : {};
  const title = (typeof tool.title === "string" && tool.title.trim()) || name;
  const description =
    typeof tool.description === "string" ? tool.description.trim() : "";
  return {
    serverId,
    originalName: name,
    qualifiedName: qualifiedToolName(serverId, name),
    title: title.slice(0, 80),
    description: description.slice(0, 1200),
    inputSchema: schema,
    annotations,
    confirmKey: confirmCategory(annotations),
  };
}

function qualifiedToolName(serverId: string, toolName: string): string {
  const safe = (value: string): string =>
    value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const raw = `mcp__${safe(serverId).slice(0, 24)}__${safe(toolName).slice(0, 24)}`;
  if (raw.length <= 64) return raw;
  const suffix = crypto
    .createHash("sha1")
    .update(raw)
    .digest("hex")
    .slice(0, 8);
  return `${raw.slice(0, 55)}_${suffix}`;
}

function confirmCategory(annotations: AnnexAnnotations): string {
  if (annotations.destructiveHint) return "mcp_write";
  if (annotations.readOnlyHint && annotations.openWorldHint)
    return "mcp_network";
  if (annotations.readOnlyHint) return "mcp_read";
  return "mcp_execute";
}

function formatCallResult(
  entry: McpToolInfo,
  result: Record<string, unknown>,
  maxChars: number,
): ToolResult {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text":
        parts.push(String(block.text ?? ""));
        break;
      case "image":
        parts.push(
          `[图片，${String(block.mimeType ?? "unknown")}，Base64 ${String(block.data ?? "").length} 字符]`,
        );
        break;
      case "audio":
        parts.push(
          `[音频，${String(block.mimeType ?? "unknown")}，Base64 ${String(block.data ?? "").length} 字符]`,
        );
        break;
      case "resource_link":
        parts.push(
          `[资源链接 ${String(block.name ?? "")}]\n${String(block.uri ?? "")}`,
        );
        break;
      case "resource": {
        const resource =
          typeof block.resource === "object" && block.resource !== null
            ? (block.resource as Record<string, unknown>)
            : {};
        parts.push(
          typeof resource.text === "string"
            ? `[资源 ${String(resource.uri ?? "")}]\n${resource.text}`
            : `[二进制资源 ${String(resource.uri ?? "")}，${String(resource.mimeType ?? "application/octet-stream")}]`,
        );
        break;
      }
      default:
        parts.push(`[未识别的 MCP 内容：${String(block.type ?? "unknown")}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent != null) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  let text = parts.join("\n\n").trim() || "MCP 工具没有返回内容";
  const truncated = text.length > maxChars;
  if (truncated) text = `${text.slice(0, maxChars)}\n\n[内容已截断]`;
  const isError = result.isError === true;
  return toolResult(
    isError ? false : true,
    isError ? "" : text,
    isError ? text : null,
    {
      server: entry.serverId,
      tool: entry.originalName,
      content_chars: text.length,
      truncated,
    },
  );
}

export const testExports = {
  confirmCategory,
  qualifiedToolName,
  formatCallResult,
};
