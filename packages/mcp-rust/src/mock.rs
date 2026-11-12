use anyhow::Result;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub async fn run() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());
    while let Some(line) = lines.next_line().await? {
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "initialize" => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "soul-mate-mock", "version": "0.1.0" }
                }
            })),
            "tools/list" => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "echo",
                            "description": "回显文本",
                            "inputSchema": {
                                "type": "object",
                                "properties": { "text": { "type": "string" } },
                                "required": ["text"]
                            },
                            "annotations": { "readOnlyHint": true }
                        },
                        {
                            "name": "slow",
                            "description": "慢工具",
                            "inputSchema": { "type": "object", "properties": {} }
                        },
                        {
                            "name": "crash",
                            "description": "退出测试",
                            "inputSchema": { "type": "object", "properties": {} }
                        }
                    ]
                }
            })),
            "tools/call" => {
                let name = message
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match name {
                    "echo" => {
                        let text = message
                            .pointer("/params/arguments/text")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        Some(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{ "type": "text", "text": format!("echo:{text}") }],
                                "isError": false
                            }
                        }))
                    }
                    "slow" => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        Some(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{ "type": "text", "text": "slow" }],
                                "isError": false
                            }
                        }))
                    }
                    "crash" => {
                        std::process::exit(7);
                    }
                    _ => Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": "unknown tool" }
                    })),
                }
            }
            "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
            _ if id.is_null() => None,
            _ => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "method not found" }
            })),
        };
        if let Some(response) = response {
            stdout.write_all(response.to_string().as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}
