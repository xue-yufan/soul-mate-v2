mod mcp;
mod mock;

use std::{io, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc},
};

use mcp::{McpServer, ServerConfig};

const GATEWAY_PROTOCOL_VERSION: u32 = 1;
const MAX_LINE_BYTES: usize = 2_000_000;
const OUTPUT_QUEUE_CAPACITY: usize = 512;

#[derive(Debug, Deserialize)]
struct IncomingEnvelope {
    v: u32,
    id: String,
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Clone)]
pub(crate) struct GatewayOutput {
    sender: mpsc::Sender<Value>,
}

impl GatewayOutput {
    pub(crate) async fn send(&self, value: Value) -> Result<()> {
        self.sender
            .send(value)
            .await
            .context("写入 MCP 网关 stdout 队列失败")
    }

    pub(crate) async fn result(&self, id: &str, payload: Value) -> Result<()> {
        self.send(json!({
            "v": GATEWAY_PROTOCOL_VERSION,
            "id": id,
            "kind": "result",
            "payload": payload,
        }))
        .await
    }

    pub(crate) async fn error(
        &self,
        id: &str,
        code: &str,
        message: impl Into<String>,
    ) -> Result<()> {
        self.send(json!({
            "v": GATEWAY_PROTOCOL_VERSION,
            "id": id,
            "kind": "error",
            "payload": {
                "code": code,
                "message": message.into(),
            },
        }))
        .await
    }

    pub(crate) async fn event(&self, data: Value) -> Result<()> {
        self.send(json!({
            "v": GATEWAY_PROTOCOL_VERSION,
            "id": "event",
            "kind": "mcp_event",
            "payload": data,
        }))
        .await
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().any(|arg| arg == "--mock-mcp-server") {
        return mock::run().await;
    }
    run_gateway().await
}

async fn run_gateway() -> Result<()> {
    let (output_sender, mut output_receiver) = mpsc::channel(OUTPUT_QUEUE_CAPACITY);
    let output = GatewayOutput {
        sender: output_sender,
    };
    let writer_task = tokio::spawn(async move {
        let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());
        while let Some(value) = output_receiver.recv().await {
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

    let server: Arc<Mutex<Option<Arc<McpServer>>>> = Arc::new(Mutex::new(None));
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut calls = tokio::task::JoinSet::new();
    eprintln!("[Rust MCP] 网关已启动");

    loop {
        let Some(line) = read_bounded_line(&mut reader, MAX_LINE_BYTES).await? else {
            break;
        };
        let line = String::from_utf8_lossy(&line);
        if line.trim().is_empty() {
            continue;
        }
        let envelope: IncomingEnvelope = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                output
                    .error("unknown", "bad_json", format!("请求 JSON 无效：{error}"))
                    .await?;
                continue;
            }
        };
        if envelope.v != GATEWAY_PROTOCOL_VERSION {
            output
                .error(
                    &envelope.id,
                    "version_mismatch",
                    format!(
                        "网关协议版本不匹配：客户端 {}，服务端 {GATEWAY_PROTOCOL_VERSION}",
                        envelope.v
                    ),
                )
                .await?;
            continue;
        }

        match envelope.kind.as_str() {
            "ping" => {
                output
                    .result(&envelope.id, json!({ "service": "rust-mcp" }))
                    .await?;
            }
            "start" => {
                if server.lock().await.is_some() {
                    output
                        .error(&envelope.id, "already_started", "MCP 网关已经启动")
                        .await?;
                    continue;
                }
                let config: ServerConfig = match serde_json::from_value(envelope.payload) {
                    Ok(config) => config,
                    Err(error) => {
                        output
                            .error(
                                &envelope.id,
                                "bad_request",
                                format!("MCP 服务配置无效：{error}"),
                            )
                            .await?;
                        continue;
                    }
                };
                match McpServer::start(config, output.clone()).await {
                    Ok(started) => {
                        let tools = started.list_tools().await;
                        match tools {
                            Ok(tools) => {
                                *server.lock().await = Some(Arc::new(started));
                                output
                                    .result(&envelope.id, json!({ "tools": tools }))
                                    .await?;
                            }
                            Err(error) => {
                                let _ = started.shutdown().await;
                                output
                                    .error(&envelope.id, "tools_list_failed", error)
                                    .await?;
                            }
                        }
                    }
                    Err(error) => {
                        output.error(&envelope.id, "start_failed", error).await?;
                    }
                }
            }
            "call" => {
                let Some(current) = server.lock().await.clone() else {
                    output
                        .error(&envelope.id, "not_started", "MCP 服务尚未启动")
                        .await?;
                    continue;
                };
                let call_id = envelope.id.clone();
                let request_id = envelope.id;
                let payload = envelope.payload;
                let output_for_call = output.clone();
                calls.spawn(async move {
                    let result = current.call_tool(&call_id, payload).await;
                    let response = match result {
                        Ok(value) => json!({ "ok": true, "result": value }),
                        Err(error) => json!({ "ok": false, "error": error }),
                    };
                    let _ = output_for_call.result(&request_id, response).await;
                });
            }
            "cancel" => {
                let call_id = envelope
                    .payload
                    .get("callId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let cancelled = match server.lock().await.clone() {
                    Some(current) => current.cancel_call(call_id).await,
                    None => false,
                };
                output
                    .result(&envelope.id, json!({ "cancelled": cancelled }))
                    .await?;
            }
            "stop" => {
                let current = server.lock().await.take();
                if let Some(current) = current
                    && let Err(error) = current.shutdown().await
                {
                    output.error(&envelope.id, "stop_failed", error).await?;
                    continue;
                }
                output.result(&envelope.id, json!({})).await?;
            }
            "shutdown" => {
                break;
            }
            unknown => {
                output
                    .error(
                        &envelope.id,
                        "unsupported_type",
                        format!("不支持的请求类型：{unknown}"),
                    )
                    .await?;
            }
        }
    }

    if let Some(current) = server.lock().await.take() {
        let _ = current.shutdown().await;
    }
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    drop(output);
    let _ = writer_task.await;
    Ok(())
}

pub(crate) async fn read_bounded_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    limit: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let bytes = {
        let mut limited = reader.take((limit + 1) as u64);
        limited.read_until(b'\n', &mut line).await?
    };
    if bytes == 0 {
        return Ok(None);
    }
    if line.len() > limit {
        if line.last() != Some(&b'\n') {
            discard_until_newline(reader).await?;
        }
        return Err(io::Error::new(io::ErrorKind::InvalidData, "请求行过大"));
    }
    Ok(Some(line))
}

async fn discard_until_newline(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<()> {
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

pub(crate) fn timeout_duration(milliseconds: u64) -> Duration {
    Duration::from_millis(milliseconds.max(1))
}
