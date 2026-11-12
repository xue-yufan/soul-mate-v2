# Rust 嵌入核心

`soul-mate-embedding-core` 是 Agent sidecar 与 N-API 模块共用的安全 Rust
推理核心，避免两套实现产生模型加载、归一化或缓存行为差异。

它提供：

- BERT/SentenceTransformer 模型、tokenizer 和 safetensors 加载；
- 批量文本长度与数量限制；
- attention-mask 均值池化和 L2 归一化；
- 同一批次 padding 后执行一次 BERT batch forward；
- 容量 4096 的 LRU 向量缓存；
- 维度、缓存项数和推理错误报告。

验证：

```powershell
cargo test --manifest-path packages/embedding-core/Cargo.toml --target-dir .tmp-cargo-target
```
