# Rust Agent 内核迁移说明

## 当前状态

Agent 热路径已经迁移到安全 Rust。默认配置为：

```yaml
agent:
  kernel: rust
  rust_command: ""
  rust_args: []
```

Node.js 宿主通过 `RustSidecarKernel` 拉起
`soul-mate-agent-rust`，使用 NDJSON 标准输入/输出通信。TypeScript Agent 保留
为回滚路径，把 `agent.kernel` 改为 `typescript` 即可恢复。

Rust v2-A 把本地嵌入热路径升级为 Node-API 进程内模块：

```yaml
embedding:
  kernel: auto # auto | napi | sidecar
  napi_addon: ""
  rust_command: ""
```

`auto` 优先加载 `soul-mate-embedding.node`，加载或推理失败时自动回退原有
`soul-mate-agent-rust --model-dir` sidecar。Agent sidecar 的职责和协议不变。

## 职责边界

Rust sidecar 负责：

- 意图路由；
- 聊天与信息专家提示词组装；
- 模型流和工具循环状态机；
- 情绪标记解析和用户可见事件；
- 按 `run_id` 路由并发运行；
- 运行超时、取消和子进程关闭；
- 协议版本、重复运行和资源上限检查。

Rust N-API 嵌入核心负责：

- 模型、tokenizer 和 safetensors 加载；
- 批量文本验证和 384 维归一化；
- 4096 项 LRU 向量缓存；
- SQLite BLOB 持久向量缓存和模型指纹失效；
- Rust 常驻向量索引与 top-k cosine 查询；
- padding + attention mask 的真实 batch forward；
- 2 个并行推理 worker 和 8 个有界等待请求；
- 请求 ID、取消标记和待绑定取消 TTL；
- 后台阻塞任务调度，避免占用 Node 事件循环；
- panic 隔离、加载状态机、缓存状态和显式卸载；
- 加载耗时、推理耗时、缓存命中、队列和失败指标。

Node.js 宿主继续负责：

- OpenAI 兼容模型 HTTP 流；
- SQLite 历史、摘要、记忆、文档和审计；
- 文件、摄像头等工具执行；
- 工具权限和用户确认；
- 配置、日志、TTS 和进程生命周期。

只有 Node.js 宿主打开 SQLite。这避免双写入者，并保证 Rust sidecar 异常时不会
损坏本地数据。

## 跨进程协议

每条消息是一行 JSON，必须包含契约版本 `v`。运行事件按
`run_id` 隔离，宿主调用和结果使用唯一的 `id` 关联。

宿主方法：

- `model.stream`
- `history.loadRecent`
- `history.loadSummary`
- `recall.query`
- `tools.list`
- `tools.execute`
- `run.cancelled`

`model.stream` 和 `tools.execute` 可以返回多个 `host_result` 块。Rust 在收到
`done=true` 或 `ok=false` 后才移除调用通道，避免后续流块被丢弃。

## 取消和退出

- Electron/Vue 发起中止时，Node 取消对应 `AbortSignal`，并发送 `cancel`。
- Rust 使用每个运行独立的 `CancellationToken` 中断模型或工具等待。
- 取消产生终端 `error` 事件，不再发送 `run_finished`。
- Node 子进程异常退出时，所有等待中的运行收到 `internal_error` 并结束。
- Rust stdin 关闭或收到 `shutdown` 时取消活动运行、清空任务并退出。
- 关闭桌面端会先等待 sidecar 正常退出，超时后终止子进程。

## 内存安全要求

- 只使用安全 Rust；不得为便利引入 `unsafe`。
- stdin 单行上限为 2 MB，超限行会被丢弃且服务继续工作。
- stdout 使用有界队列；队列拥塞时快速失败，避免无限增长。
- 单次宿主调用使用容量为 64 的有界通道。
- 同时运行的 Agent 数量上限为 64。
- Node 每个运行最多缓存 4096 个事件，stdin 缓冲超过 8 MB 时终止异常 sidecar。
- 嵌入模式限制文本条数、单条长度和输出缓冲。
- N-API 使用 Node-API ABI，不绑定具体 Node 或 Electron 版本；模型与缓存由
  Rust 所有权管理，不使用项目自定义 `unsafe`。
- 早于异步请求注册到达的取消 ID 只保留 10 秒，最多 1024 项；超过上限时清空，
  防止取消请求造成无界内存增长。
- SQLite 持久缓存最多保留 20000 条当前模型向量；候选预过滤上限可通过
  `memory.candidate_limit` 和 `rag.candidate_limit` 调整。

## 验证

```powershell
npm run test:rust
npm run test -w @soul-mate/backend
cargo clippy --manifest-path packages/agent-rust/Cargo.toml --all-targets -- -D warnings
```

真实 Rust 二进制测试覆盖握手、两路并发流、多块 `host_result`、取消、超大输入
和运行中关闭。Node 测试覆盖子进程异常退出、运行隔离、工具多块流以及真实
Rust 二进制的宿主回调。嵌入测试分别覆盖 N-API 真实模型加载、相关性排序、
LRU 淘汰、Rust 取消、本地 AbortSignal 中止、失败状态机、panic 转换和 N-API
失败后的 sidecar 回退。

## Rust v2-C：MCP 网关

Windows-first 的 stdio MCP 网关由 `packages/mcp-rust` 提供：

- 使用换行分隔 JSON-RPC 2.0；
- 串行初始化、`notifications/initialized` 和分页 `tools/list`；
- 支持并发 `tools/call`、调用 ID 取消和超时通知；
- 响应服务端 `ping`、`roots/list`，拒绝未知采样请求；
- 限制 2 MB 消息、256 个工具、100 条 stderr 和 256 个待绑定取消；
- MCP 子进程退出时唤醒全部等待调用，网关本身继续响应诊断；
- 关闭网关时先关闭 stdin，超时后由 Windows `taskkill /T /F` 回收进程树。

Node 宿主仍拥有配置、权限和用户确认。MCP 工具以 `mcp__server__tool`
形式进入现有 ToolHost，普通聊天和信息专家都可以使用。
