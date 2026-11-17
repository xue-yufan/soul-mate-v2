# Rust Agent / 嵌入 sidecar

`soul-mate-agent-rust` 是 Soul Mate v2 的安全 Rust 常驻 sidecar。同一个二进制
支持两种启动模式：

```text
soul-mate-agent-rust
  -> Rust Agent NDJSON 服务

soul-mate-agent-rust --model-dir <目录>
  -> Rust 本地嵌入 NDJSON 服务
```

项目不再为 Agent 与嵌入分别维护两个可执行文件。Agent 默认启用，Node.js
宿主通过 `agent.kernel=rust` 选择它。

## Rust Agent 能力

- 按 `run_id` 同时处理多个对话运行，事件不会串流；
- 负责意图路由、聊天/信息提示词和流式工具循环；
- 通过 `host_call` 请求宿主提供模型、历史、记忆、工具和取消状态；
- 通过 `host_result` 按调用 ID 回传多块模型/工具流；
- 支持单个运行超时、外部取消、重复运行 ID 拒绝和并发上限；
- stdin 关闭、`shutdown`、宿主退出或写入失败时释放全部任务；
- 输入行、stdout 队列、宿主流通道和活动运行数均有上限；
- 不使用项目自定义 `unsafe`。

Node.js 宿主继续拥有 SQLite、模型 HTTP、记忆存储、工具执行、权限确认和
用户界面。这样既保持 SQLite 单写入者，也允许把 `agent.kernel` 改为
`typescript` 完成即时回滚。

## 宿主协议

所有消息均为单行 JSON，必须携带契约版本 `v`：

```json
{"v":1,"id":"run-1","run_id":"run-1","kind":"run","payload":{}}
{"v":1,"id":"run-1:1","run_id":"run-1","kind":"host_call","method":"model.stream","payload":{}}
{"v":1,"id":"run-1:1","run_id":"run-1","kind":"host_result","payload":{"ok":true,"chunk":{},"stream":true}}
{"v":1,"id":"run-1:1","run_id":"run-1","kind":"host_result","payload":{"ok":true,"done":true}}
```

已实现的宿主方法：

- `model.stream`
- `history.loadRecent`
- `history.loadSummary`
- `recall.query`
- `tools.list`
- `tools.execute`
- `run.cancelled`

流式调用只有在 `payload.done=true` 或 `payload.ok=false` 时才释放调用通道，
因此同一调用中的后续块不会覆盖或丢失。

## 嵌入模式

嵌入模式使用 Candle 加载本地 BERT/SentenceTransformer 的 `config.json`、
`tokenizer.json` 和 `model.safetensors`，输出 L2 归一化向量。支持：

- `ping`
- `embed`
- `shutdown`

模型不可用时，Node.js 后端自动回退到纯 SQLite 词项检索。

## 构建

```powershell
npm run build:rust
```

发布二进制位于：

```text
.cargo-target/release/soul-mate-agent-rust.exe
```

Electron 打包时该文件会复制到：

```text
resources/agent-rust/soul-mate-agent-rust.exe
```

如果要显式指定其他可执行文件，可配置：

```yaml
agent:
  kernel: rust
  rust_command: "D:/path/to/soul-mate-agent-rust.exe"
  rust_args: []
```

## 验证

```powershell
npm run test:rust
cargo clippy --manifest-path packages/agent-rust/Cargo.toml --all-targets -- -D warnings
npm run test -w @soul-mate/backend
```

Rust 集成测试会启动真实二进制，覆盖握手、并发运行、多块流、取消、超大输入
和运行中关闭。Node 测试还会启动真实发布二进制，验证 `host_call/host_result`
与最终 Agent 事件。
