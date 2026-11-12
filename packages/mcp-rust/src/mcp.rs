use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

use crate::{GatewayOutput, read_bounded_line, timeout_duration};

const MAX_TOOLS: usize = 256;
const MAX_STDERR_LINES: u64 = 100;
const MAX_STDERR_CHARS: usize = 2_000;
const MAX_PRE_CANCELLATIONS: usize = 256;

type Writer = Arc<Mutex<tokio::io::BufWriter<ChildStdin>>>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_ms: u64,
    #[serde(default = "default_list_timeout")]
    pub list_timeout_ms: u64,
}

fn default_connect_timeout() -> u64 {
    10_000
}

fn default_list_timeout() -> u64 {
    30_000
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallPayload {
    tool: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default = "default_call_timeout")]
    timeout_ms: u64,
}

fn default_call_timeout() -> u64 {
    30_000
}

struct ActiveCall {
    token: CancellationToken,
}

#[derive(Default)]
struct CallState {
    active: HashMap<String, ActiveCall>,
    pre_cancelled: HashSet<String>,
}

pub struct McpServer {
    id: String,
    writer: Writer,
    pending: Pending,
    call_state: Arc<Mutex<CallState>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    pid: u32,
    list_timeout_ms: u64,
}

impl McpServer {
    pub async fn start(config: ServerConfig, output: GatewayOutput) -> Result<Self, String> {
        if config.id.trim().is_empty() {
            return Err("MCP server id 不能为空".to_owned());
        }
        if config.command.trim().is_empty() {
            return Err(format!("MCP 服务 {} 缺少 command", config.id));
        }
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = config
            .cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.as_std_mut().creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("启动 MCP 服务失败：{}", config.command))
            .map_err(|error| error.to_string())?;
        let pid = child.id().ok_or_else(|| "MCP 服务没有进程 ID".to_owned())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP 服务 stdin 不可用".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP 服务 stdout 不可用".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "MCP 服务 stderr 不可用".to_owned())?;

        let writer = Arc::new(Mutex::new(tokio::io::BufWriter::new(stdin)));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let call_state = Arc::new(Mutex::new(CallState::default()));
        let alive = Arc::new(AtomicBool::new(true));
        let server = Self {
            id: config.id,
            writer: writer.clone(),
            pending: pending.clone(),
            call_state,
            next_id: AtomicU64::new(1),
            alive: alive.clone(),
            pid,
            list_timeout_ms: config.list_timeout_ms,
        };

        spawn_stdout_reader(
            server.id.clone(),
            stdout,
            writer.clone(),
            pending.clone(),
            alive.clone(),
            output.clone(),
            pid,
        );
        spawn_stderr_reader(server.id.clone(), stderr, output.clone());
        spawn_waiter(server.id.clone(), child, pending, alive, output);

        let initialize = server
            .request_with_timeout(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "soul-mate-v2",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
                config.connect_timeout_ms,
            )
            .await;
        if let Err(error) = initialize {
            let _ = server.shutdown().await;
            return Err(format!("MCP 初始化失败：{error}"));
        }
        server
            .notify("notifications/initialized", json!({}))
            .await
            .map_err(|error| format!("发送 MCP 初始化通知失败：{error}"))?;
        Ok(server)
    }

    pub async fn list_tools(&self) -> Result<Vec<Value>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let result = self
                .request_with_timeout("tools/list", params, self.list_timeout_ms)
                .await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| "MCP tools/list 响应缺少 tools".to_owned())?;
            for tool in page {
                if tools.len() >= MAX_TOOLS {
                    return Err(format!("MCP 工具数量超过上限 {MAX_TOOLS}"));
                }
                tools.push(tool.clone());
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(&self, call_id: &str, payload: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(format!("MCP 服务 {} 已断开", self.id));
        }
        let payload: CallPayload = serde_json::from_value(payload)
            .map_err(|error| format!("MCP 调用参数无效：{error}"))?;
        let rpc_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        let pre_cancelled = {
            let mut state = self.call_state.lock().await;
            if state.active.contains_key(call_id) {
                return Err("重复的 MCP 调用 ID".to_owned());
            }
            state.active.insert(
                call_id.to_owned(),
                ActiveCall {
                    token: token.clone(),
                },
            );
            state.pre_cancelled.remove(call_id)
        };
        if pre_cancelled {
            token.cancel();
        }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(rpc_id, sender);
        if let Err(error) = self
            .write(json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "method": "tools/call",
                "params": {
                    "name": payload.tool,
                    "arguments": payload.arguments,
                }
            }))
            .await
        {
            self.pending.lock().await.remove(&rpc_id);
            self.call_state.lock().await.active.remove(call_id);
            return Err(error.to_string());
        }

        let result = tokio::select! {
            _ = token.cancelled() => Err("MCP 工具调用已取消".to_owned()),
            _ = tokio::time::sleep(timeout_duration(payload.timeout_ms)) => {
                Err("MCP 工具调用超时".to_owned())
            }
            result = receiver => result
                .map_err(|_| format!("MCP 服务 {} 已断开", self.id))
                .and_then(|result| result),
        };
        self.pending.lock().await.remove(&rpc_id);
        self.call_state.lock().await.active.remove(call_id);
        if result.is_err() {
            let _ = self
                .notify(
                    "notifications/cancelled",
                    json!({
                        "requestId": rpc_id,
                        "reason": result.as_ref().err().cloned().unwrap_or_default(),
                    }),
                )
                .await;
        }
        result
    }

    pub async fn cancel_call(&self, call_id: &str) -> bool {
        let mut state = self.call_state.lock().await;
        if let Some(call) = state.active.get(call_id) {
            call.token.cancel();
            return true;
        }
        if state.pre_cancelled.len() >= MAX_PRE_CANCELLATIONS {
            state.pre_cancelled.clear();
        }
        state.pre_cancelled.insert(call_id.to_owned());
        true
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        fail_pending(&self.pending, format!("MCP 服务 {} 正在关闭", self.id)).await;
        if let Ok(mut writer) = self.writer.try_lock() {
            let _ = writer.shutdown().await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        #[cfg(windows)]
        terminate_process_tree(self.pid).await;
        Ok(())
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await
        .map_err(|error| error.to_string())?;
        let received = tokio::time::timeout(timeout_duration(timeout_ms), receiver).await;
        self.pending.lock().await.remove(&id);
        received
            .map_err(|_| format!("MCP 请求 {method} 超时"))?
            .map_err(|_| format!("MCP 服务 {} 已断开", self.id))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn write(&self, value: Value) -> Result<()> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(value.to_string().as_bytes())
            .await
            .context("写入 MCP stdin 失败")?;
        writer.write_all(b"\n").await.context("写入 MCP 换行失败")?;
        writer.flush().await.context("刷新 MCP stdin 失败")
    }
}

fn spawn_stdout_reader(
    server_id: String,
    stdout: tokio::process::ChildStdout,
    writer: Writer,
    pending: Pending,
    alive: Arc<AtomicBool>,
    output: GatewayOutput,
    pid: u32,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let line = match read_bounded_line(&mut reader, 2_000_000).await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    let _ = output
                        .event(json!({
                            "server": server_id,
                            "stream": "stdout",
                            "message": format!("MCP 输出行无效：{error}"),
                        }))
                        .await;
                    #[cfg(windows)]
                    terminate_process_tree(pid).await;
                    break;
                }
            };
            let message: Value = match serde_json::from_slice(&line) {
                Ok(value) => value,
                Err(error) => {
                    let _ = output
                        .event(json!({
                            "server": server_id,
                            "stream": "stdout",
                            "message": format!("MCP 返回非法 JSON：{error}"),
                        }))
                        .await;
                    continue;
                }
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64)
                && message.get("method").is_none()
            {
                let sender = pending.lock().await.remove(&id);
                if let Some(sender) = sender {
                    let result = if let Some(error) = message.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("MCP JSON-RPC 错误")
                            .to_owned())
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = sender.send(result);
                }
                continue;
            }
            if let (Some(id), Some(method)) = (
                message.get("id").cloned(),
                message.get("method").and_then(Value::as_str),
            ) {
                let reply = match method {
                    "ping" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {},
                    }),
                    "roots/list" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "roots": [] },
                    }),
                    _ => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": format!("客户端不支持 MCP 请求：{method}"),
                        }
                    }),
                };
                let mut writer = writer.lock().await;
                let _ = writer.write_all(reply.to_string().as_bytes()).await;
                let _ = writer.write_all(b"\n").await;
                let _ = writer.flush().await;
            }
        }
        alive.store(false, Ordering::Release);
        fail_pending(&pending, format!("MCP 服务 {server_id} 输出已关闭")).await;
    });
}

fn spawn_stderr_reader(
    server_id: String,
    stderr: tokio::process::ChildStderr,
    output: GatewayOutput,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut lines = 0u64;
        loop {
            let line = match read_bounded_line(&mut reader, 64_000).await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => continue,
                Err(_) => break,
            };
            if lines >= MAX_STDERR_LINES {
                continue;
            }
            lines += 1;
            let message = String::from_utf8_lossy(&line).trim().to_owned();
            if message.is_empty() {
                continue;
            }
            let _ = output
                .event(json!({
                    "server": server_id,
                    "stream": "stderr",
                    "message": message.chars().take(MAX_STDERR_CHARS).collect::<String>(),
                }))
                .await;
        }
    });
}

fn spawn_waiter(
    server_id: String,
    mut child: tokio::process::Child,
    pending: Pending,
    alive: Arc<AtomicBool>,
    output: GatewayOutput,
) {
    tokio::spawn(async move {
        let status = child.wait().await;
        alive.store(false, Ordering::Release);
        fail_pending(&pending, format!("MCP 服务 {server_id} 已退出")).await;
        let _ = output
            .event(json!({
                "server": server_id,
                "stream": "exit",
                "message": status
                    .map(|status| format!("MCP 服务已退出：{status}"))
                    .unwrap_or_else(|error| format!("等待 MCP 服务退出失败：{error}")),
            }))
            .await;
    });
}

async fn fail_pending(pending: &Pending, message: String) {
    let mut pending = pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(message.clone()));
    }
}

#[cfg(windows)]
async fn terminate_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}
