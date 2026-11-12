use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::Duration,
};

use serde_json::{Value, json};

const TIMEOUT: Duration = Duration::from_secs(10);

struct Gateway {
    child: Child,
    stdin: ChildStdin,
    output: Receiver<Value>,
}

impl Gateway {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_soul-mate-mcp-rust"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("启动 MCP 网关失败");
        let stdin = child.stdin.take().expect("缺少网关 stdin");
        let stdout = child.stdout.take().expect("缺少网关 stdout");
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(value) = serde_json::from_str::<Value>(&line)
                    && sender.send(value).is_err()
                {
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
        serde_json::to_writer(&mut self.stdin, &value).expect("序列化网关请求失败");
        self.stdin.write_all(b"\n").expect("写入网关请求失败");
        self.stdin.flush().expect("刷新网关请求失败");
    }

    fn receive(&self) -> Value {
        match self.output.recv_timeout(TIMEOUT) {
            Ok(value) => value,
            Err(RecvTimeoutError::Timeout) => panic!("等待 MCP 网关输出超时"),
            Err(RecvTimeoutError::Disconnected) => panic!("MCP 网关输出已关闭"),
        }
    }

    fn response(&self, id: &str) -> Value {
        loop {
            let value = self.receive();
            if value["id"] == id {
                return value;
            }
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
fn discovers_calls_cancels_and_survives_mcp_crash() {
    let mut gateway = Gateway::start();
    gateway.send(json!({
        "v": 1,
        "id": "start",
        "kind": "start",
        "payload": {
            "id": "mock",
            "command": env!("CARGO_BIN_EXE_soul-mate-mcp-rust"),
            "args": ["--mock-mcp-server"],
            "env": {},
            "cwd": null,
            "connectTimeoutMs": 5000
        }
    }));
    let started = gateway.response("start");
    assert_eq!(started["kind"], "result");
    let tools = started["payload"]["tools"]
        .as_array()
        .expect("缺少工具数组");
    assert!(tools.iter().any(|tool| tool["name"] == "echo"));

    gateway.send(json!({
        "v": 1,
        "id": "echo-call",
        "kind": "call",
        "payload": {
            "tool": "echo",
            "arguments": { "text": "你好" },
            "timeoutMs": 5000
        }
    }));
    let echoed = gateway.response("echo-call");
    assert_eq!(echoed["payload"]["ok"], true);
    assert_eq!(
        echoed["payload"]["result"]["content"][0]["text"],
        "echo:你好"
    );

    gateway.send(json!({
        "v": 1,
        "id": "slow-call",
        "kind": "call",
        "payload": {
            "tool": "slow",
            "arguments": {},
            "timeoutMs": 10000
        }
    }));
    gateway.send(json!({
        "v": 1,
        "id": "cancel-slow",
        "kind": "cancel",
        "payload": { "callId": "slow-call" }
    }));
    let cancelled = gateway.response("slow-call");
    assert_eq!(cancelled["payload"]["ok"], false);
    assert!(
        cancelled["payload"]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("取消")
    );

    gateway.send(json!({
        "v": 1,
        "id": "crash-call",
        "kind": "call",
        "payload": {
            "tool": "crash",
            "arguments": {},
            "timeoutMs": 5000
        }
    }));
    let crashed = gateway.response("crash-call");
    assert_eq!(crashed["payload"]["ok"], false);

    gateway.send(json!({
        "v": 1,
        "id": "ping-after-crash",
        "kind": "ping",
        "payload": {}
    }));
    let ping = gateway.response("ping-after-crash");
    assert_eq!(ping["kind"], "result");

    gateway.send(json!({
        "v": 1,
        "id": "shutdown",
        "kind": "shutdown",
        "payload": {}
    }));
    gateway.stdin.flush().expect("刷新关闭请求失败");
}
