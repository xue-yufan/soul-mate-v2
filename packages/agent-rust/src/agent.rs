use std::{
    collections::HashMap,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;

use crate::PROTOCOL_VERSION;

const MAX_LINE_BYTES: usize = 2_000_000;
const MAX_TOOL_STEPS_FALLBACK: usize = 5;
const MAX_ACTIVE_RUNS: usize = 64;
const WRITER_QUEUE_CAPACITY: usize = 1_024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub risk_level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunInput {
    pub text: String,
    pub request_id: String,
    pub session_id: String,
    #[serde(default)]
    pub current_user_message_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunContext {
    pub system_prompt: String,
    pub model_name: String,
    pub history_turns: usize,
    pub max_tool_steps: usize,
    pub run_timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunPayload {
    pub input: AgentRunInput,
    pub context: AgentRunContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChunk {
    #[serde(default)]
    pub delta: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub tokens_in: u64,
    #[serde(default)]
    pub tokens_out: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersistedAgentMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "toolCalls")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "toolCallId")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentError {
    pub code: String,
    pub message: String,
}

impl AgentError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn internal(error: impl fmt::Display) -> Self {
        Self::new("internal_error", error.to_string())
    }

    fn cancelled() -> Self {
        Self::new("cancelled", "生成被取消")
    }

    fn timeout() -> Self {
        Self::new("run_timeout", "思考时间过长，请重试")
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AgentError {}

#[derive(Debug, Deserialize)]
struct IncomingEnvelope {
    v: u32,
    id: String,
    kind: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    payload: Value,
}

type Writer = mpsc::Sender<Value>;
type HostSender = mpsc::Sender<Value>;

pub struct AgentServer {
    writer: Writer,
    pending_host_calls: Arc<Mutex<HashMap<String, HostSender>>>,
    runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    next_call_id: AtomicU64,
}

impl AgentServer {
    fn new(writer: Writer) -> Self {
        Self {
            writer,
            pending_host_calls: Arc::new(Mutex::new(HashMap::new())),
            runs: Arc::new(Mutex::new(HashMap::new())),
            next_call_id: AtomicU64::new(1),
        }
    }

    fn send(&self, value: Value) -> Result<()> {
        self.writer
            .try_send(value)
            .context("写入 Rust stdout 队列失败")
    }

    fn send_event(&self, run_id: &str, event: AgentEvent) -> Result<()> {
        self.send(json!({
            "v": PROTOCOL_VERSION,
            "id": run_id,
            "run_id": run_id,
            "kind": "agent_event",
            "payload": event,
        }))
    }

    fn send_error(&self, run_id: &str, error: &AgentError) -> Result<()> {
        self.send_event(
            run_id,
            AgentEvent {
                event_type: "error".to_owned(),
                data: json!({ "code": error.code, "message": error.message }),
            },
        )
    }

    async fn start_host_stream(
        &self,
        run_id: &str,
        method: &str,
        payload: Value,
        token: &CancellationToken,
    ) -> Result<HostStream, AgentError> {
        if token.is_cancelled() {
            return Err(AgentError::cancelled());
        }
        let call_id = format!(
            "{}:{}",
            run_id,
            self.next_call_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::channel::<Value>(64);
        self.pending_host_calls
            .lock()
            .await
            .insert(call_id.clone(), sender);
        self.send(json!({
            "v": PROTOCOL_VERSION,
            "id": call_id,
            "run_id": run_id,
            "kind": "host_call",
            "method": method,
            "payload": payload,
        }))
        .map_err(AgentError::internal)?;
        Ok(HostStream { call_id, receiver })
    }

    async fn host_request(
        &self,
        run_id: &str,
        method: &str,
        payload: Value,
        token: &CancellationToken,
    ) -> Result<Value, AgentError> {
        let mut stream = self
            .start_host_stream(run_id, method, payload, token)
            .await?;
        loop {
            let frame = stream.next(token).await?;
            if frame.get("ok").and_then(Value::as_bool) == Some(false) {
                return Err(AgentError::internal(
                    frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("宿主调用失败"),
                ));
            }
            if frame.get("done").and_then(Value::as_bool) == Some(true) {
                return Ok(frame.get("data").cloned().unwrap_or(Value::Null));
            }
        }
    }

    async fn cleanup_run(&self, run_id: &str) {
        self.runs.lock().await.remove(run_id);
        self.pending_host_calls
            .lock()
            .await
            .retain(|call_id, _| !call_id.starts_with(&format!("{run_id}:")));
    }
}

struct HostStream {
    call_id: String,
    receiver: mpsc::Receiver<Value>,
}

impl HostStream {
    async fn next(&mut self, token: &CancellationToken) -> Result<Value, AgentError> {
        tokio::select! {
            _ = token.cancelled() => Err(AgentError::cancelled()),
            frame = self.receiver.recv() => frame
                .ok_or_else(|| AgentError::internal(format!("宿主调用 {} 已断开", self.call_id))),
        }
    }
}

fn assistant_with_tool_calls(text: &str, tool_calls: &[ToolCall]) -> ChatMessage {
    ChatMessage {
        role: "assistant".to_owned(),
        content: text.to_owned(),
        name: None,
        tool_call_id: None,
        tool_calls: if tool_calls.is_empty() {
            None
        } else {
            Some(tool_calls.to_vec())
        },
    }
}

fn tool_result_message(call: &ToolCall, content: String) -> ChatMessage {
    ChatMessage {
        role: "tool".to_owned(),
        content,
        name: Some(call.name.clone()),
        tool_call_id: Some(call.id.clone()),
        tool_calls: None,
    }
}

fn build_chat_prompt(system_prompt: &str, vision: bool) -> String {
    let mut parts = vec![system_prompt.to_owned()];
    if vision {
        parts.push(
            "【当前可用：视觉观察】\n当用户询问眼前画面、动作或环境，或只有看一帧当前画面才能回答时，可以调用 look_through_camera。\n普通闲聊、情绪陪伴和不需要当前画面的知识问题不要调用。\n工具没有拿到画面时要直接说明没看清，不要臆测。".to_owned(),
        );
    }
    parts.push(emotion_instruction().to_owned());
    parts.join("\n\n")
}

fn build_info_prompt(system_prompt: &str) -> String {
    format!(
        "{system_prompt}\n\n【当前专家：信息查询】\n你正在处理信息查询请求。\n\
         - 简洁、准确\n- 只依据已知信息回答，不确定就说明\n\
         - 有工具时优先调用工具获取实时信息\n- 查不到就直说\n\n{}",
        emotion_instruction()
    )
}

fn emotion_instruction() -> &'static str {
    "【输出格式】\n每次回复必须以完整情绪标签开头，例如：\n\
     <emotion>happy</emotion>\n正文……\n\
     可选值：neutral、happy、sad、surprised、shy、thinking、angry。"
}

fn normalize_emotion(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "neutral" | "happy" | "sad" | "surprised" | "shy" | "thinking" | "angry" => value,
        _ => "neutral".to_owned(),
    }
}

fn parse_emotion(text: &str) -> Option<(String, usize)> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("<emotion>")?;
    if start != 0 {
        return None;
    }
    let value_start = start + "<emotion>".len();
    let end = lower.find("</emotion>")?;
    let emotion = normalize_emotion(&text[value_start..end]);
    let mut consumed = end + "</emotion>".len();
    while consumed < text.len() && text.as_bytes()[consumed].is_ascii_whitespace() {
        consumed += 1;
    }
    Some((emotion, consumed))
}

fn could_be_emotion_prefix(text: &str) -> bool {
    let target = "<emotion>";
    let trimmed = text.trim_start().to_ascii_lowercase();
    if target.starts_with(&trimmed) || trimmed.starts_with(target) {
        return true;
    }
    trimmed.starts_with("<emotion>") || trimmed.starts_with('<')
}

fn rule_intent(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    let info = lower.contains("天气")
        || lower.contains("气温")
        || lower.contains("时间")
        || lower.contains("日期")
        || lower.contains("星期")
        || lower.contains("几点")
        || lower.contains("查一下")
        || lower.contains("搜索")
        || lower.contains("检索")
        || lower.contains("资料")
        || lower.contains("文档")
        || lower.contains("知识")
        || lower.contains("weather")
        || lower.contains("what time");
    if info {
        Some("info")
    } else if text.trim().chars().count() < 5 {
        Some("chat")
    } else {
        None
    }
}

async fn classify_intent(
    server: &AgentServer,
    run_id: &str,
    input: &AgentRunInput,
    token: &CancellationToken,
) -> Result<(String, u64, u64), AgentError> {
    if let Some(intent) = rule_intent(&input.text) {
        return Ok((intent.to_owned(), 0, 0));
    }
    let messages = vec![
        ChatMessage {
            role: "system".to_owned(),
            content: "只把用户最后一句话分类为 chat 或 info。闲聊、情绪陪伴、角色扮演输出 chat；查询事实、时间、天气、资料输出 info。只输出一个单词。".to_owned(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: "user".to_owned(),
            content: input.text.clone(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        },
    ];
    let mut stream = server
        .start_host_stream(
            run_id,
            "model.stream",
            json!({ "messages": messages, "tools": [] }),
            token,
        )
        .await?;
    let mut raw = String::new();
    let mut tokens_in = 0;
    let mut tokens_out = 0;
    loop {
        let frame = stream.next(token).await?;
        if frame.get("ok").and_then(Value::as_bool) == Some(false) {
            return Ok(("chat".to_owned(), 0, 0));
        }
        if let Some(chunk) = frame.get("chunk").and_then(Value::as_object) {
            if let Some(delta) = chunk.get("delta").and_then(Value::as_str) {
                raw.push_str(delta);
            }
            tokens_in += chunk.get("tokensIn").and_then(Value::as_u64).unwrap_or(0);
            tokens_out += chunk.get("tokensOut").and_then(Value::as_u64).unwrap_or(0);
        }
        if raw.trim().len() >= 8 || frame.get("done").and_then(Value::as_bool) == Some(true) {
            break;
        }
    }
    Ok((
        if raw.to_ascii_lowercase().contains("info") {
            "info".to_owned()
        } else {
            "chat".to_owned()
        },
        tokens_in,
        tokens_out,
    ))
}

async fn run_model_stream(
    server: &AgentServer,
    run_id: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    token: &CancellationToken,
    mut on_delta: impl FnMut(&str, u64, u64) -> Result<(), AgentError>,
) -> Result<(Vec<ToolCall>, u64, u64), AgentError> {
    let mut stream = server
        .start_host_stream(
            run_id,
            "model.stream",
            json!({ "messages": messages, "tools": tools }),
            token,
        )
        .await?;
    let mut tool_calls = Vec::new();
    let mut tokens_in = 0;
    let mut tokens_out = 0;
    loop {
        let frame = stream.next(token).await?;
        if frame.get("ok").and_then(Value::as_bool) == Some(false) {
            return Err(AgentError::internal(
                frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("模型调用失败"),
            ));
        }
        if let Some(chunk_value) = frame.get("chunk") {
            let chunk: ModelChunk =
                serde_json::from_value(chunk_value.clone()).map_err(AgentError::internal)?;
            tokens_in += chunk.tokens_in;
            tokens_out += chunk.tokens_out;
            if !chunk.delta.is_empty() {
                on_delta(&chunk.delta, chunk.tokens_in, chunk.tokens_out)?;
            }
            if !chunk.tool_calls.is_empty() {
                tool_calls = chunk.tool_calls;
            }
        }
        if frame.get("done").and_then(Value::as_bool) == Some(true) {
            break;
        }
    }
    Ok((tool_calls, tokens_in, tokens_out))
}

async fn execute_tool(
    server: &AgentServer,
    run_id: &str,
    call: &ToolCall,
    expert: &str,
    token: &CancellationToken,
) -> Result<(String, String), AgentError> {
    let mut stream = server
        .start_host_stream(
            run_id,
            "tools.execute",
            json!({ "call": call, "expert": expert }),
            token,
        )
        .await?;
    let mut terminal = "missing".to_owned();
    let mut content = String::new();
    loop {
        let frame = stream.next(token).await?;
        if frame.get("ok").and_then(Value::as_bool) == Some(false) {
            return Ok((
                "result".to_owned(),
                format!(
                    "工具执行失败：{}",
                    frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("未知错误")
                ),
            ));
        }
        if let Some(event) = frame.get("chunk") {
            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
            let data = event.get("data").cloned().unwrap_or(Value::Null);
            if kind == "tool_result" {
                terminal = "result".to_owned();
                content = if data.get("ok").and_then(Value::as_bool) == Some(true) {
                    data.get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned()
                } else {
                    format!(
                        "工具执行失败：{}",
                        data.get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("未知错误")
                    )
                };
            } else if kind == "tool_denied" {
                terminal = "denied".to_owned();
                content = data
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("用户拒绝")
                    .to_owned();
            }
            server
                .send_event(
                    run_id,
                    AgentEvent {
                        event_type: kind.to_owned(),
                        data,
                    },
                )
                .map_err(AgentError::internal)?;
        }
        if frame.get("done").and_then(Value::as_bool) == Some(true) {
            break;
        }
    }
    Ok((terminal, content))
}

async fn run_agent(
    server: &AgentServer,
    run_id: &str,
    payload: RunPayload,
    token: &CancellationToken,
) -> Result<(), AgentError> {
    let input = payload.input;
    let context = payload.context;
    server
        .send_event(
            run_id,
            AgentEvent {
                event_type: "run_started".to_owned(),
                data: json!({}),
            },
        )
        .map_err(AgentError::internal)?;

    let (expert, mut tokens_in, mut tokens_out) =
        classify_intent(server, run_id, &input, token).await?;
    server
        .send_event(
            run_id,
            AgentEvent {
                event_type: "expert_selected".to_owned(),
                data: json!({ "expert": expert }),
            },
        )
        .map_err(AgentError::internal)?;

    let summary = server
        .host_request(
            run_id,
            "history.loadSummary",
            json!({ "sessionId": input.session_id }),
            token,
        )
        .await?
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let recall = server
        .host_request(
            run_id,
            "recall.query",
            json!({ "query": input.text }),
            token,
        )
        .await?
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let history_value = server
        .host_request(
            run_id,
            "history.loadRecent",
            json!({
                "sessionId": input.session_id,
                "maxTurns": context.history_turns,
                "excludeMessageId": input.current_user_message_id,
            }),
            token,
        )
        .await?;
    let history: Vec<ChatMessage> =
        serde_json::from_value(history_value.get("messages").cloned().unwrap_or(json!([])))
            .map_err(AgentError::internal)?;

    let mut system_parts = vec![context.system_prompt.clone()];
    if !summary.is_empty() {
        system_parts.push(format!("【对话摘要】\n{summary}"));
    }
    if !recall.is_empty() {
        system_parts.push(recall);
    }
    let base_system_prompt = system_parts.join("\n\n");
    let mut base_messages = vec![ChatMessage {
        role: "system".to_owned(),
        content: base_system_prompt.clone(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }];
    base_messages.extend(history);
    base_messages.push(ChatMessage {
        role: "user".to_owned(),
        content: input.text.clone(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    });

    let tools_value = server
        .host_request(run_id, "tools.list", json!({ "expert": expert }), token)
        .await?;
    let all_tools: Vec<ToolDefinition> =
        serde_json::from_value(tools_value.get("tools").cloned().unwrap_or(json!([])))
            .map_err(AgentError::internal)?;
    let vision_available = all_tools
        .iter()
        .any(|tool| tool.name == "look_through_camera");
    let visible_tools = if expert == "info" {
        all_tools
    } else {
        all_tools
            .into_iter()
            .filter(|tool| tool.name == "look_through_camera" || tool.name.starts_with("mcp__"))
            .collect()
    };
    let prompt = if expert == "info" {
        build_info_prompt(&base_system_prompt)
    } else {
        build_chat_prompt(&base_system_prompt, vision_available)
    };

    let mut messages = base_messages.clone();
    if let Some(first) = messages.first_mut() {
        first.content = prompt;
    }
    let mut pending_tools = Vec::new();
    let mut persisted = Vec::new();
    let mut full_text = String::new();
    let mut tool_steps = 0;
    let max_tool_steps = if context.max_tool_steps == 0 {
        MAX_TOOL_STEPS_FALLBACK
    } else {
        context.max_tool_steps
    };

    loop {
        if token.is_cancelled() {
            return Err(AgentError::cancelled());
        }
        let available_tools = if tool_steps < max_tool_steps {
            visible_tools.clone()
        } else {
            Vec::new()
        };
        let mut response_text = String::new();
        let mut emotion_buffer = String::new();
        let mut emotion_resolved = false;
        let mut detected_emotion = false;
        let (tool_calls, call_tokens_in, call_tokens_out) = {
            let mut emit_delta = |delta: &str, _, _| -> Result<(), AgentError> {
                if emotion_resolved {
                    response_text.push_str(delta);
                    full_text.push_str(delta);
                    server
                        .send_event(
                            run_id,
                            AgentEvent {
                                event_type: "text_delta".to_owned(),
                                data: json!({ "text": delta }),
                            },
                        )
                        .map_err(AgentError::internal)?;
                    return Ok(());
                }
                emotion_buffer.push_str(delta);
                if let Some((emotion, consumed)) = parse_emotion(&emotion_buffer) {
                    detected_emotion = true;
                    emotion_resolved = true;
                    let rest = emotion_buffer[consumed..].to_owned();
                    emotion_buffer.clear();
                    server
                        .send_event(
                            run_id,
                            AgentEvent {
                                event_type: "emotion".to_owned(),
                                data: json!({ "emotion": emotion }),
                            },
                        )
                        .map_err(AgentError::internal)?;
                    if !rest.is_empty() {
                        response_text.push_str(&rest);
                        full_text.push_str(&rest);
                        server
                            .send_event(
                                run_id,
                                AgentEvent {
                                    event_type: "text_delta".to_owned(),
                                    data: json!({ "text": rest }),
                                },
                            )
                            .map_err(AgentError::internal)?;
                    }
                } else if emotion_buffer.len() > 100 || !could_be_emotion_prefix(&emotion_buffer) {
                    let text = std::mem::take(&mut emotion_buffer);
                    emotion_resolved = true;
                    response_text.push_str(&text);
                    full_text.push_str(&text);
                    server
                        .send_event(
                            run_id,
                            AgentEvent {
                                event_type: "text_delta".to_owned(),
                                data: json!({ "text": text }),
                            },
                        )
                        .map_err(AgentError::internal)?;
                }
                Ok(())
            };
            run_model_stream(
                server,
                run_id,
                &messages,
                &available_tools,
                token,
                &mut emit_delta,
            )
            .await?
        };
        tokens_in += call_tokens_in;
        tokens_out += call_tokens_out;

        if !emotion_resolved && !emotion_buffer.is_empty() {
            if let Some((emotion, consumed)) = parse_emotion(&emotion_buffer) {
                detected_emotion = true;
                let rest = emotion_buffer[consumed..].to_owned();
                server
                    .send_event(
                        run_id,
                        AgentEvent {
                            event_type: "emotion".to_owned(),
                            data: json!({ "emotion": emotion }),
                        },
                    )
                    .map_err(AgentError::internal)?;
                response_text.push_str(&rest);
                full_text.push_str(&rest);
                if !rest.is_empty() {
                    server
                        .send_event(
                            run_id,
                            AgentEvent {
                                event_type: "text_delta".to_owned(),
                                data: json!({ "text": rest }),
                            },
                        )
                        .map_err(AgentError::internal)?;
                }
            } else {
                let text = std::mem::take(&mut emotion_buffer);
                response_text.push_str(&text);
                full_text.push_str(&text);
                server
                    .send_event(
                        run_id,
                        AgentEvent {
                            event_type: "text_delta".to_owned(),
                            data: json!({ "text": text }),
                        },
                    )
                    .map_err(AgentError::internal)?;
            }
        }
        if !detected_emotion {
            server
                .send_event(
                    run_id,
                    AgentEvent {
                        event_type: "emotion".to_owned(),
                        data: json!({ "emotion": "neutral" }),
                    },
                )
                .map_err(AgentError::internal)?;
        }

        let assistant = assistant_with_tool_calls(&response_text, &tool_calls);
        if !response_text.is_empty() || !tool_calls.is_empty() {
            persisted.push(PersistedAgentMessage {
                role: "assistant".to_owned(),
                content: response_text.clone(),
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls.clone())
                },
                tool_call_id: None,
                name: None,
            });
        }
        if tool_calls.is_empty() {
            server
                .send_event(
                    run_id,
                    AgentEvent {
                        event_type: "run_finished".to_owned(),
                        data: json!({
                            "text": full_text,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                            "model": context.model_name,
                            "messages": persisted,
                        }),
                    },
                )
                .map_err(AgentError::internal)?;
            return Ok(());
        }
        if tool_steps >= max_tool_steps {
            return Err(AgentError::new("tool_loop_limit", "工具调用次数超限"));
        }

        let mut next_tool_messages = Vec::new();
        let mut denied_reason: Option<String> = None;
        for call in &tool_calls {
            if let Some(reason) = denied_reason.as_deref() {
                let synthetic_reason = "同一批工具请求已取消";
                server.send_event(
                    run_id,
                    AgentEvent {
                        event_type: "tool_call_started".to_owned(),
                        data: json!({
                            "request_id": input.request_id,
                            "tool_call_id": call.id,
                            "tool": call.name,
                            "args": serde_json::from_str::<Value>(&call.arguments).unwrap_or(json!({})),
                        }),
                    },
                )
                .map_err(AgentError::internal)?;
                server
                    .send_event(
                        run_id,
                        AgentEvent {
                            event_type: "tool_denied".to_owned(),
                            data: json!({
                                "request_id": input.request_id,
                                "tool_call_id": call.id,
                                "tool": call.name,
                                "reason": synthetic_reason,
                            }),
                        },
                    )
                    .map_err(AgentError::internal)?;
                let content = format!("用户拒绝执行：{reason}");
                next_tool_messages.push(tool_result_message(call, content.clone()));
                persisted.push(PersistedAgentMessage {
                    role: "tool".to_owned(),
                    content,
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                    name: Some(call.name.clone()),
                });
                continue;
            }
            let (terminal, content) = execute_tool(server, run_id, call, &expert, token).await?;
            if terminal == "denied" {
                denied_reason = Some(content.clone());
            }
            let result_content = if terminal == "denied" {
                format!("用户拒绝执行：{content}")
            } else if terminal == "missing" {
                "工具没有返回结果".to_owned()
            } else {
                content
            };
            next_tool_messages.push(tool_result_message(call, result_content.clone()));
            persisted.push(PersistedAgentMessage {
                role: "tool".to_owned(),
                content: result_content,
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
                name: Some(call.name.clone()),
            });
        }

        if let Some(reason) = denied_reason {
            let decline = "……好，那便不动它了。若是需要，随时同我说。";
            full_text.push_str(decline);
            persisted.push(PersistedAgentMessage {
                role: "assistant".to_owned(),
                content: decline.to_owned(),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
            server
                .send_event(
                    run_id,
                    AgentEvent {
                        event_type: "text_delta".to_owned(),
                        data: json!({ "text": decline }),
                    },
                )
                .map_err(AgentError::internal)?;
            let _ = reason;
            server
                .send_event(
                    run_id,
                    AgentEvent {
                        event_type: "run_finished".to_owned(),
                        data: json!({
                            "text": full_text,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                            "model": context.model_name,
                            "messages": persisted,
                        }),
                    },
                )
                .map_err(AgentError::internal)?;
            return Ok(());
        }

        tool_steps += 1;
        pending_tools.push(assistant);
        pending_tools.extend(next_tool_messages);
        messages = base_messages.clone();
        messages.extend(pending_tools.clone());
    }
}

async fn handle_incoming(
    server: &Arc<AgentServer>,
    envelope: IncomingEnvelope,
    tasks: &mut tokio::task::JoinSet<()>,
) -> Result<bool> {
    if envelope.v != PROTOCOL_VERSION {
        server.send(json!({
            "v": PROTOCOL_VERSION,
            "id": envelope.id,
            "kind": "error",
            "payload": {
                "code": "version_mismatch",
                "message": format!(
                    "协议版本不匹配：客户端 {}，服务端 {PROTOCOL_VERSION}",
                    envelope.v
                ),
            },
        }))?;
        return Ok(false);
    }
    match envelope.kind.as_str() {
        "ping" => {
            server.send(json!({
                "v": PROTOCOL_VERSION,
                "id": envelope.id,
                "kind": "pong",
                "payload": {
                    "service": "rust-agent",
                    "protocol": PROTOCOL_VERSION,
                },
            }))?;
        }
        "run" => {
            let run_id = envelope.id.clone();
            let payload: RunPayload =
                serde_json::from_value(envelope.payload).context("解析 Rust run payload 失败")?;
            let token = CancellationToken::new();
            {
                let mut runs = server.runs.lock().await;
                if runs.contains_key(&run_id) {
                    drop(runs);
                    server.send(json!({
                        "v": PROTOCOL_VERSION,
                        "id": run_id,
                        "kind": "error",
                        "payload": {
                            "code": "bad_request",
                            "message": "重复的运行 ID",
                        },
                    }))?;
                    return Ok(false);
                }
                if runs.len() >= MAX_ACTIVE_RUNS {
                    drop(runs);
                    server.send_error(
                        &run_id,
                        &AgentError::new("too_many_runs", "并发运行数量已达上限"),
                    )?;
                    return Ok(false);
                }
                runs.insert(run_id.clone(), token.clone());
            }
            let server_for_task = server.clone();
            let run_id_for_task = run_id.clone();
            let timeout = Duration::from_millis(payload.context.run_timeout_ms.max(1));
            tasks.spawn(async move {
                let result = tokio::select! {
                    _ = token.cancelled() => Err(AgentError::cancelled()),
                    _ = tokio::time::sleep(timeout) => Err(AgentError::timeout()),
                    result = run_agent(&server_for_task, &run_id_for_task, payload, &token) => result,
                };
                if let Err(error) = result {
                    let _ = server_for_task.send_error(&run_id_for_task, &error);
                }
                server_for_task.cleanup_run(&run_id_for_task).await;
            });
        }
        "cancel" => {
            let run_id = envelope.run_id.unwrap_or(envelope.id);
            if let Some(token) = server.runs.lock().await.get(&run_id) {
                token.cancel();
            }
        }
        "host_result" => {
            let terminal = envelope.payload.get("done").and_then(Value::as_bool) == Some(true)
                || envelope.payload.get("ok").and_then(Value::as_bool) == Some(false);
            let sender = if terminal {
                server.pending_host_calls.lock().await.remove(&envelope.id)
            } else {
                server
                    .pending_host_calls
                    .lock()
                    .await
                    .get(&envelope.id)
                    .cloned()
            };
            if let Some(sender) = sender {
                let _ = sender.send(envelope.payload).await;
            }
        }
        "shutdown" => return Ok(true),
        unknown => {
            server.send(json!({
                "v": PROTOCOL_VERSION,
                "id": envelope.id,
                "kind": "error",
                "payload": {
                    "code": "unsupported_type",
                    "message": format!("不支持的请求类型：{unknown}"),
                },
            }))?;
        }
    }
    Ok(false)
}

pub async fn run_stdio_server() -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let (writer, mut receiver) = mpsc::channel::<Value>(WRITER_QUEUE_CAPACITY);
    let writer_task = tokio::spawn(async move {
        let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());
        while let Some(value) = receiver.recv().await {
            let Ok(line) = serde_json::to_string(&value) else {
                break;
            };
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    let server = Arc::new(AgentServer::new(writer));
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut tasks = tokio::task::JoinSet::new();
    eprintln!("[Rust Agent] NDJSON 服务已启动");

    loop {
        let mut line = Vec::new();
        let bytes = {
            let mut limited = (&mut reader).take((MAX_LINE_BYTES + 1) as u64);
            limited.read_until(b'\n', &mut line).await?
        };
        if bytes == 0 {
            break;
        }
        if line.len() > MAX_LINE_BYTES {
            if line.last() != Some(&b'\n') {
                discard_until_newline(&mut reader).await?;
            }
            server.send(json!({
                "v": PROTOCOL_VERSION,
                "id": "unknown",
                "kind": "error",
                "payload": { "code": "bad_request", "message": "请求行过大" },
            }))?;
            continue;
        }
        let line = std::str::from_utf8(&line).context("请求不是有效的 UTF-8")?;
        if line.trim().is_empty() {
            continue;
        }
        let envelope: IncomingEnvelope = match serde_json::from_str(line) {
            Ok(envelope) => envelope,
            Err(error) => {
                server.send(json!({
                    "v": PROTOCOL_VERSION,
                    "id": "unknown",
                    "kind": "error",
                    "payload": {
                        "code": "bad_json",
                        "message": format!("请求 JSON 无效：{error}"),
                    },
                }))?;
                continue;
            }
        };
        if handle_incoming(&server, envelope, &mut tasks).await? {
            break;
        }
    }

    for token in server.runs.lock().await.values() {
        token.cancel();
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    drop(server);
    let _ = writer_task.await;
    Ok(())
}

async fn discard_until_newline(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
) -> std::io::Result<()> {
    use tokio::io::AsyncBufReadExt;

    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(());
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        let done = available[consumed - 1] == b'\n';
        reader.consume(consumed);
        if done {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::rule_intent;

    #[test]
    fn short_messages_use_chat_without_model_call() {
        assert_eq!(rule_intent("你好"), Some("chat"));
        assert_eq!(rule_intent("晚安"), Some("chat"));
    }

    #[test]
    fn information_keywords_take_precedence() {
        assert_eq!(rule_intent("天气"), Some("info"));
        assert_eq!(rule_intent("几点"), Some("info"));
        assert_eq!(rule_intent("今天想和你聊一会儿"), None);
    }
}
