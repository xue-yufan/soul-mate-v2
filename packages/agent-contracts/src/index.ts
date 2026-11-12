/**
 * Language-neutral boundary for the Soul Mate agent kernel.
 *
 * The kernel owns routing, prompting and the tool loop. Host services own I/O:
 * model transport, history, memory recall, tool execution and permission UI.
 * A future Rust kernel can implement the same contract over JSON-RPC/stdio.
 */

export const AGENT_CONTRACT_VERSION = 1 as const;

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: AgentMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ModelStreamChunk {
  delta?: string;
  finishReason?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: ToolCall[];
}

export interface ModelStreamOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelPort {
  stream(
    messages: readonly ChatMessage[],
    options?: ModelStreamOptions,
  ): AsyncIterable<ModelStreamChunk>;
}

export interface HistoryLoadOptions {
  maxTurns: number;
  excludeMessageId?: string;
}

export interface HistoryPort {
  loadRecent(
    sessionId: string,
    options: HistoryLoadOptions,
  ): Promise<ChatMessage[]>;
  loadSummary(sessionId: string): Promise<string | null>;
}

export interface RecallPort {
  recall(query: string, signal?: AbortSignal): Promise<string>;
}

export type ExpertName = "chat" | "info";
export type RiskLevel = "safe" | "confirm" | "dangerous";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskLevel: RiskLevel;
  confirmKey?: string;
  displayName?: string;
}

export interface ToolCallContext {
  requestId: string;
  sessionId: string;
  expert: ExpertName;
  signal: AbortSignal;
}

export interface ToolHost {
  listTools(context: ToolCallContext): Promise<ToolDefinition[]>;
  execute(
    call: ToolCall,
    context: ToolCallContext,
  ): AsyncIterable<ToolHostEvent>;
}

export type ToolHostEvent =
  | {
      type: "tool_call_started";
      data: ToolCallStartedEvent;
    }
  | {
      type: "tool_confirm_request";
      data: ToolConfirmRequestEvent;
    }
  | {
      type: "tool_result";
      data: ToolResultEvent;
    }
  | {
      type: "tool_denied";
      data: ToolDeniedEvent;
    };

export interface ToolCallStartedEvent {
  [key: string]: unknown;
  request_id: string;
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolConfirmRequestEvent {
  [key: string]: unknown;
  request_id: string;
  tool_call_id: string;
  confirm_id: string;
  tool: string;
  args: Record<string, unknown>;
  timeout_s: number;
  prompt?: string;
}

export interface ToolResultEvent {
  [key: string]: unknown;
  request_id: string;
  tool_call_id: string;
  tool: string;
  ok: boolean;
  content: string;
  error: string | null;
  meta: Record<string, unknown>;
}

export interface ToolDeniedEvent {
  [key: string]: unknown;
  request_id: string;
  tool_call_id: string;
  tool: string;
  reason: string;
}

export interface AgentRunInput {
  text: string;
  requestId: string;
  sessionId: string;
  currentUserMessageId?: string;
}

export interface AgentRunContext {
  model: ModelPort;
  history: HistoryPort;
  recall: RecallPort;
  tools: ToolHost;
  systemPrompt: string;
  modelName: string;
  historyTurns: number;
  maxToolSteps: number;
  runTimeoutMs: number;
}

export interface AgentKernel {
  readonly id: string;
  readonly contractVersion: typeof AGENT_CONTRACT_VERSION;
  run(
    input: AgentRunInput,
    context: AgentRunContext,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}

export type AgentEventType =
  | "run_started"
  | "expert_selected"
  | "emotion"
  | "text_delta"
  | "tool_call_started"
  | "tool_confirm_request"
  | "tool_result"
  | "tool_denied"
  | "run_finished"
  | "error";

export interface AgentEvent {
  type: AgentEventType;
  data: Record<string, unknown>;
}

export interface PersistedAgentMessage {
  role: "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

/**
 * Stable IPC envelope for the Rust sidecar.
 *
 * Host->kernel and kernel->host messages must carry `v`. Requests and responses
 * are correlated by `id`; streamed agent output uses `agent_event`.
 */
export interface KernelIpcEnvelope<T = unknown> {
  v: typeof AGENT_CONTRACT_VERSION;
  id: string;
  run_id?: string;
  kind:
    | "run"
    | "cancel"
    | "ping"
    | "pong"
    | "shutdown"
    | "host_call"
    | "host_result"
    | "agent_event"
    | "error";
  method?: string;
  payload: T;
}

/**
 * Stable host callback names for the Rust kernel.
 *
 * The Rust process owns routing, prompting and the streaming tool loop, while
 * the Node host remains the only owner of model HTTP, SQLite and tool execution.
 * Every callback is request/response correlated by `KernelIpcEnvelope.id`.
 */
export type KernelHostMethod =
  | "model.stream"
  | "history.loadRecent"
  | "history.loadSummary"
  | "memory.embed"
  | "recall.query"
  | "tools.list"
  | "tools.execute"
  | "run.cancelled";

export interface KernelHostCall<T = unknown> {
  v: typeof AGENT_CONTRACT_VERSION;
  id: string;
  run_id: string;
  kind: "host_call";
  method: KernelHostMethod;
  payload: T;
}

export interface KernelHostResult<T = unknown> {
  v: typeof AGENT_CONTRACT_VERSION;
  id: string;
  run_id?: string;
  kind: "host_result";
  payload: T;
}

export interface KernelHostResultPayload {
  ok?: boolean;
  done?: boolean;
  stream?: boolean;
  data?: unknown;
  chunk?: unknown;
  error?: string;
}
