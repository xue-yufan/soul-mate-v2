# Rust N-API 嵌入内核

`soul-mate-embedding-napi` 是 Rust v2-A 的进程内嵌入模块。它通过 Node-API
向 Node.js/Electron 暴露 `NativeEmbeddingKernel`，不依赖具体 Node ABI，也不
要求 Electron 单独重编译。

## 能力

- 加载 BERT/SentenceTransformer `config.json`、`tokenizer.json` 和
  `model.safetensors`；
- 输出按输入顺序排列的 L2 归一化向量；
- Rust 内维护容量为 4096 的 LRU 文本向量缓存；
- SQLite 持久向量由 Node 单写，重启后按模型指纹复用；
- Rust 常驻索引完成 cosine top-k，只把有限结果返回 JavaScript；
- padding + attention mask 的 batch forward；
- 模型加载和推理通过后台阻塞任务执行，不占用 Node 事件循环；
- `load`、`embed(requestId, texts)`、`cancel(requestId)`、`status`、`unload`；
- 2 个并行推理 worker、最多 8 个等待请求；
- 请求取消支持请求启动前到达的待绑定取消标记；
- panic 被转换为 N-API 错误，不允许越过 FFI 终止 Node；
- 状态机：`unloaded`、`loading`、`ready`、`failed`；
- 状态中包含缓存命中、推理耗时、加载耗时、队列和失败计数；
- 限制单次 64 条文本、单条 8000 字节；
- 所有内存由 Rust 所有权管理，不使用项目自定义 `unsafe`。

JavaScript 接口：

```js
const { NativeEmbeddingKernel } = require("./soul-mate-embedding.node");
const kernel = new NativeEmbeddingKernel();
const dimension = await kernel.load("D:/models/mini-lm");
const vectors = await kernel.embed("request-1", ["你好", "今天怎么样"]);
kernel.cancel("request-2");
kernel.status();
await kernel.unload();
```

## 构建

```powershell
npm run build:rust-napi
```

构建脚本使用共享目录 `.cargo-target`，输出：

```text
packages/embedding-napi/dist/soul-mate-embedding.node
```

Electron 打包时复制到：

```text
resources/embedding-napi/soul-mate-embedding.node
```

## 回滚

默认配置：

```yaml
embedding:
  kernel: auto
  napi_addon: ""
  rust_command: ""
```

- `napi`：只允许进程内模块；
- `sidecar`：强制使用原 `soul-mate-agent-rust --model-dir`；
- `auto`：优先 N-API，失败后自动回退 sidecar。

模型加载失败、Addon 缺失和推理失败都会回退到纯 SQLite 词项检索，保证聊天和
Agent 流程可用。

## 基准

```powershell
npm run bench:embedding -- D:/models/mini-lm
npm run bench:embedding:sidecar -- D:/models/mini-lm
```

两份基准使用相同模型，输出模型加载、16 条冷批、缓存命中批、两路并发、
RSS、缓存命中率和完整内核指标，可直接比较 N-API 与 sidecar。
