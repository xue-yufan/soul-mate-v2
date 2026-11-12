mod agent;

use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use soul_mate_embedding_core::EmbeddingEngine;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
const MAX_LINE_BYTES: usize = 2_000_000;

#[derive(Debug, Deserialize)]
struct Request {
    v: u32,
    id: String,
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    v: u32,
    id: String,
    kind: &'static str,
    payload: Value,
}

enum Mode {
    Agent,
    Embedding(PathBuf),
}

fn parse_args() -> Result<Option<Mode>> {
    let mut model_dir = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--protocol-version" => {
                println!("{PROTOCOL_VERSION}");
                return Ok(None);
            }
            "--model-dir" => {
                model_dir = Some(PathBuf::from(
                    args.next().context("--model-dir 后必须提供模型目录")?,
                ));
            }
            unknown => bail!("未知参数：{unknown}"),
        }
    }
    Ok(Some(match model_dir {
        Some(path) => Mode::Embedding(path),
        None => Mode::Agent,
    }))
}

fn write_response(writer: &mut impl Write, response: &Response) -> Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn error_response(id: String, message: impl Into<String>) -> Response {
    Response {
        v: PROTOCOL_VERSION,
        id,
        kind: "error",
        payload: json!({
            "code": "rust_embedding_error",
            "message": message.into(),
        }),
    }
}

fn handle_request(model: &EmbeddingEngine, request: Request) -> Response {
    if request.v != PROTOCOL_VERSION {
        return error_response(
            request.id,
            format!(
                "协议版本不匹配：客户端 {}，服务端 {PROTOCOL_VERSION}",
                request.v
            ),
        );
    }
    match request.kind.as_str() {
        "ping" => Response {
            v: PROTOCOL_VERSION,
            id: request.id,
            kind: "pong",
            payload: json!({
                "service": "rust-embedding",
                "protocol": PROTOCOL_VERSION,
                "dimension": model.dimension(),
            }),
        },
        "embed" => {
            let texts = request
                .payload
                .get("texts")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            match model.embed(&texts) {
                Ok(vectors) => Response {
                    v: PROTOCOL_VERSION,
                    id: request.id,
                    kind: "embedding_result",
                    payload: json!({
                        "dimension": vectors.first().map(Vec::len).unwrap_or(0),
                        "vectors": vectors,
                    }),
                },
                Err(error) => error_response(request.id, error.to_string()),
            }
        }
        kind => error_response(request.id, format!("不支持的请求类型：{kind}")),
    }
}

fn main() -> Result<()> {
    let Some(mode) = parse_args()? else {
        return Ok(());
    };
    let Mode::Embedding(model_dir) = mode else {
        return tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?
            .block_on(agent::run_stdio_server());
    };
    eprintln!("[Rust 嵌入] 正在加载模型：{}", model_dir.display());
    let model = EmbeddingEngine::load(&model_dir)?;
    eprintln!("[Rust 嵌入] 模型加载完成，等待 NDJSON 请求");

    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut reader = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        if bytes > MAX_LINE_BYTES {
            let response = error_response("unknown".to_owned(), "请求行过大");
            write_response(&mut stdout, &response)?;
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(trimmed) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut stdout,
                    &error_response("unknown".to_owned(), format!("请求 JSON 无效：{error}")),
                )?;
                continue;
            }
        };
        if request.kind == "shutdown" {
            return Ok(());
        }
        let response = handle_request(&model, request);
        write_response(&mut stdout, &response)?;
    }
    Ok(())
}
