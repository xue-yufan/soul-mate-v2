use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

const VERSION: u64 = 1;
const TIMEOUT: Duration = Duration::from_secs(8);

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    output: Receiver<Result<Value, String>>,
}

impl AgentProcess {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_soul-mate-agent-rust"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("启动 Rust Agent 失败");
        let stdin = child.stdin.take().expect("缺少 stdin");
        let stdout = child.stdout.take().expect("缺少 stdout");
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let parsed = line.map_err(|error| error.to_string()).and_then(|line| {
                    serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())
                });
                if sender.send(parsed).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            output,
        }
    }

    fn send(&mut self, value: Value) {
        serde_json::to_writer(&mut self.stdin, &value).expect("序列化请求失败");
        self.stdin.write_all(b"\n").expect("写入请求失败");
        self.stdin.flush().expect("刷新请求失败");
    }

    fn receive(&self) -> Value {
        match self.output.recv_timeout(TIMEOUT) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => panic!("Rust Agent 输出无效 JSON：{error}"),
            Err(RecvTimeoutError::Timeout) => panic!("等待 Rust Agent 输出超时"),
            Err(RecvTimeoutError::Disconnected) => panic!("Rust Agent 输出通道已断开"),
        }
    }

    fn ping(&mut self) {
        self.send(json!({
            "v": VERSION,
            "id": "ping-test",
            "kind": "ping",
            "payload": {},
        }));
        let response = self.receive();
        assert_eq!(response["kind"], "pong");
        assert_eq!(response["id"], "ping-test");
        assert_eq!(response["payload"]["service"], "rust-agent");
    }

    fn send_raw_line(&mut self, bytes: &[u8]) {
        self.stdin.write_all(bytes).expect("写入原始请求失败");
        self.stdin.write_all(b"\n").expect("写入换行失败");
        self.stdin.flush().expect("刷新原始请求失败");
    }

    fn wait_for_exit(&mut self) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().expect("查询子进程状态失败") {
                assert!(status.success(), "Rust Agent 异常退出：{status}");
                return;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                panic!("Rust Agent 未在超时前退出");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn run_message(run_id: &str, text: &str) -> Value {
    json!({
        "v": VERSION,
        "id": run_id,
        "run_id": run_id,
        "kind": "run",
        "payload": {
            "input": {
                "text": text,
                "requestId": run_id,
                "sessionId": format!("session-{run_id}"),
            },
            "context": {
                "systemPrompt": "测试人格",
                "modelName": "mock-model",
                "historyTurns": 2,
                "maxToolSteps": 2,
                "runTimeoutMs": 5_000,
            },
        },
    })
}

fn respond(process: &mut AgentProcess, call: &Value, model_chunks: &[&str]) {
    respond_with_context(process, call, model_chunks, "", "", None);
}

fn respond_with_context(
    process: &mut AgentProcess,
    call: &Value,
    model_chunks: &[&str],
    summary: &str,
    recall: &str,
    mut captured_model_messages: Option<&mut Vec<Value>>,
) {
    let id = call["id"].as_str().expect("host_call 缺少 id");
    let run_id = call["run_id"].as_str().expect("host_call 缺少 run_id");
    let payload = match call["method"].as_str().expect("host_call 缺少 method") {
        "history.loadSummary" => {
            json!({ "ok": true, "done": true, "data": { "summary": summary } })
        }
        "recall.query" => json!({ "ok": true, "done": true, "data": { "text": recall } }),
        "history.loadRecent" => {
            json!({ "ok": true, "done": true, "data": { "messages": [] } })
        }
        "tools.list" => json!({ "ok": true, "done": true, "data": { "tools": [] } }),
        "model.stream" => {
            if let Some(captured) = captured_model_messages.as_deref_mut() {
                captured.push(call["payload"]["messages"].clone());
            }
            for text in model_chunks {
                process.send(json!({
                    "v": VERSION,
                    "id": id,
                    "run_id": run_id,
                    "kind": "host_result",
                    "payload": {
                        "ok": true,
                        "stream": true,
                        "chunk": {
                            "delta": text,
                            "tokensIn": 1,
                            "tokensOut": 1,
                        },
                    },
                }));
            }
            json!({ "ok": true, "stream": true, "done": true })
        }
        method => panic!("测试未处理宿主调用：{method}"),
    };
    process.send(json!({
        "v": VERSION,
        "id": id,
        "run_id": run_id,
        "kind": "host_result",
        "payload": payload,
    }));
}

fn wait_for_events(
    process: &mut AgentProcess,
    expected_runs: usize,
    chunks_by_run: &HashMap<String, Vec<&str>>,
) -> HashMap<String, String> {
    let mut finished = 0;
    let mut texts: HashMap<String, String> = HashMap::new();
    while finished < expected_runs {
        let message = process.receive();
        if message["kind"] == "host_call" {
            let run_id = message["run_id"].as_str().expect("host_call 缺少 run_id");
            let chunks = chunks_by_run.get(run_id).map(Vec::as_slice).unwrap_or(&[]);
            respond(process, &message, chunks);
            continue;
        }
        if message["kind"] != "agent_event" {
            continue;
        }
        let run_id = message["run_id"]
            .as_str()
            .expect("agent_event 缺少 run_id")
            .to_owned();
        let event_type = message["payload"]["type"]
            .as_str()
            .expect("agent_event 缺少 type");
        if event_type == "text_delta" {
            let text = message["payload"]["data"]["text"]
                .as_str()
                .expect("text_delta 缺少文本");
            texts.entry(run_id).or_default().push_str(text);
        }
        if event_type == "run_finished" {
            finished += 1;
        }
        assert_ne!(event_type, "error", "运行意外失败：{message}");
    }
    texts
}

#[test]
fn agent_handshake_streams_multiple_chunks_and_isolates_runs() {
    let mut process = AgentProcess::start();
    process.ping();
    process.send(run_message("run-a", "天气 A"));
    process.send(run_message("run-b", "天气 B"));
    let chunks = HashMap::from([
        ("run-a".to_owned(), vec!["A-第一段", "A-第二段"]),
        ("run-b".to_owned(), vec!["B-第一段", "B-第二段"]),
    ]);

    let texts = wait_for_events(&mut process, 2, &chunks);
    assert_eq!(
        texts.get("run-a").map(String::as_str),
        Some("A-第一段A-第二段")
    );
    assert_eq!(
        texts.get("run-b").map(String::as_str),
        Some("B-第一段B-第二段")
    );
}

#[test]
fn model_receives_persona_summary_and_recall() {
    let mut process = AgentProcess::start();
    let mut captured = Vec::new();
    process.send(run_message("run-context", "天气上下文"));

    loop {
        let message = process.receive();
        if message["kind"] == "host_call" {
            respond_with_context(
                &mut process,
                &message,
                &["已读取上下文"],
                "此前讨论过用户的作息。",
                "【相关记忆】\n用户的猫叫团子。",
                Some(&mut captured),
            );
            continue;
        }
        if message["kind"] != "agent_event" {
            continue;
        }
        let event_type = message["payload"]["type"]
            .as_str()
            .expect("agent_event 缺少 type");
        assert_ne!(event_type, "error", "运行意外失败：{message}");
        if event_type == "run_finished" {
            break;
        }
    }

    let messages = captured
        .first()
        .and_then(Value::as_array)
        .expect("未捕获 model.stream messages");
    let system = messages
        .iter()
        .find(|message| message["role"] == "system")
        .and_then(|message| message["content"].as_str())
        .expect("model.stream 缺少 system message");

    for expected in [
        "测试人格",
        "此前讨论过用户的作息。",
        "用户的猫叫团子。",
        "【当前专家：信息查询】",
        "【输出格式】",
    ] {
        assert!(
            system.contains(expected),
            "system message 缺少 {expected:?}：{system}"
        );
    }
}

#[test]
fn cancellation_terminates_a_waiting_run_without_finishing_it() {
    let mut process = AgentProcess::start();
    process.send(run_message("run-cancel", "天气取消"));
    process.send(json!({
        "v": VERSION,
        "id": "run-cancel",
        "run_id": "run-cancel",
        "kind": "cancel",
        "payload": {},
    }));

    let deadline = Instant::now() + TIMEOUT;
    let mut cancelled = false;
    let mut finished = false;
    while Instant::now() < deadline && !cancelled {
        let message = process.receive();
        if message["kind"] == "host_call" {
            continue;
        }
        if message["run_id"] != "run-cancel" || message["kind"] != "agent_event" {
            continue;
        }
        cancelled = message["payload"]["type"] == "error"
            && message["payload"]["data"]["code"] == "cancelled";
        finished |= message["payload"]["type"] == "run_finished";
    }
    assert!(cancelled, "取消后未收到 cancelled 错误");
    assert!(!finished, "取消后不应发送 run_finished");

    process.ping();
}

#[test]
fn shutdown_terminates_the_process_with_active_runs() {
    let mut process = AgentProcess::start();
    process.send(run_message("run-shutdown", "天气关闭"));
    process.send(json!({
        "v": VERSION,
        "id": "shutdown-test",
        "kind": "shutdown",
        "payload": {},
    }));
    process.wait_for_exit();
}

#[test]
fn oversized_input_is_rejected_without_losing_the_protocol_stream() {
    let mut process = AgentProcess::start();
    process.send_raw_line(&vec![b'x'; 2_000_010]);
    let response = process.receive();
    assert_eq!(response["kind"], "error");
    assert_eq!(response["payload"]["code"], "bad_request");
    process.ping();
}
