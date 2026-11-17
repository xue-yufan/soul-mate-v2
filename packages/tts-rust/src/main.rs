mod decoder_builder;
mod engine;
mod lexicon;
mod wav;

use anyhow::{Context, Result};
use clap::Parser;
use engine::SpeechEngine;
use serde::Deserialize;
use std::io::Read;
use std::path::PathBuf;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const MAX_REQUEST_BYTES: u64 = 1_000_000;

#[derive(Parser, Debug)]
#[command(name = "soul-mate-tts-rust")]
struct Arguments {
    #[arg(long)]
    model_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 9890)]
    port: u16,
    #[arg(long, default_value = "GPU")]
    device: String,
    #[arg(long)]
    cache_dir: PathBuf,
}

#[derive(Deserialize)]
struct TtsRequest {
    text: String,
}

fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let environment = ort::init()
        .with_name("soul-mate-tts-rust")
        .with_telemetry(false)
        .build()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut engine = SpeechEngine::new(
        environment,
        &arguments.model_dir,
        &arguments.cache_dir,
        &arguments.device,
    )?;
    let server = Server::http(format!("{}:{}", arguments.host, arguments.port))
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    eprintln!(
        "[TTS/Rust] ready: front=CPU, decoder=OpenVINO:{}, model={}",
        arguments.device,
        arguments
            .model_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
    );

    for request in server.incoming_requests() {
        if let Err(error) = handle_request(request, &mut engine) {
            eprintln!("[TTS/Rust] request failed: {error:#}");
        }
    }
    Ok(())
}

fn handle_request(mut request: tiny_http::Request, engine: &mut SpeechEngine) -> Result<()> {
    let path = request.url().split('?').next().unwrap_or(request.url());
    match (request.method(), path) {
        (&Method::Get, "/healthz") => {
            respond_json(request, 200, &serde_json::json!({"status": "ok"}))
        }
        (&Method::Get, "/openapi.json") => respond_json(
            request,
            200,
            &serde_json::json!({"paths": {"/tts": {"post": {}}}}),
        ),
        (&Method::Post, "/tts") => {
            let mut body = Vec::new();
            request
                .as_reader()
                .take(MAX_REQUEST_BYTES + 1)
                .read_to_end(&mut body)
                .context("failed to read request body")?;
            if body.is_empty() || body.len() as u64 > MAX_REQUEST_BYTES {
                return respond_json(
                    request,
                    413,
                    &serde_json::json!({"error": "invalid request size"}),
                );
            }
            let payload: TtsRequest =
                serde_json::from_slice(&body).context("invalid JSON request")?;
            let text = payload.text.trim();
            if text.is_empty() {
                return respond_json(
                    request,
                    400,
                    &serde_json::json!({"error": "text must not be empty"}),
                );
            }
            match engine.synthesize(text) {
                Ok(audio) => {
                    let content_type =
                        Header::from_bytes(b"Content-Type".as_slice(), b"audio/wav".as_slice())
                            .expect("static response header");
                    request
                        .respond(Response::from_data(audio).with_header(content_type))
                        .context("failed to send TTS response")
                }
                Err(error) => respond_json(
                    request,
                    500,
                    &serde_json::json!({"error": format!("{error:#}")}),
                ),
            }
        }
        _ => respond_json(request, 404, &serde_json::json!({"error": "not found"})),
    }
}

fn respond_json(
    request: tiny_http::Request,
    status_code: u16,
    value: &serde_json::Value,
) -> Result<()> {
    let content_type = Header::from_bytes(
        b"Content-Type".as_slice(),
        b"application/json; charset=utf-8".as_slice(),
    )
    .expect("static response header");
    request
        .respond(
            Response::from_string(value.to_string())
                .with_status_code(StatusCode(status_code))
                .with_header(content_type),
        )
        .context("failed to send JSON response")
}
