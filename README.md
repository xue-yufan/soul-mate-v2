# Soul Mate v2

Soul Mate v2 是一个本地优先的 Electron + Vue 桌面角色聊天应用。项目由
TypeScript 后端、Vue 渲染层、SQLite 持久化、Agent 内核契约和可选的本地
视觉/语音能力组成。Agent 路由、提示词、模型流和工具循环已迁移到安全 Rust
sidecar，Node.js 宿主继续负责模型 HTTP、SQLite、工具执行和用户授权。

## 主要能力

- 角色人格、流式对话、情绪表情和 VRM 3D 角色渲染
- 聊天历史、成本记录、长期记忆、文档 RAG 和世界书
- 本地工具调用与用户确认
- Windows stdio MCP 工具网关（Rust JSON-RPC/子进程生命周期）
- 摄像头单帧观察和本地视觉模型
- GPT-SoVITS HTTP 语音合成
- Rust Agent sidecar：多运行复用、`host_call/host_result`、取消和进程回收
- Rust N-API 进程内嵌入内核，保留 sidecar 自动回退（Candle + safetensors）
- N-API 有界并发、推理取消、panic 隔离和嵌入性能/健康指标
- Electron 主进程管理后端生命周期和本地鉴权

## 项目结构

| 路径                            | 作用                                                |
| ------------------------------- | --------------------------------------------------- |
| `apps/desktop`                  | Electron + Vue 桌面端、3D 角色和知识管理界面        |
| `apps/backend`                  | Fastify HTTP/WebSocket 后端、SQLite、工具与语音适配 |
| `packages/agent-contracts`      | Agent 与宿主之间的版本化跨语言契约                  |
| `packages/agent-ts`             | 可随时回滚的 TypeScript Agent 内核                  |
| `packages/agent-rust`           | 默认 Rust Agent 与嵌入 sidecar                      |
| `packages/embedding-core`       | Agent 与 N-API 共用的安全 Rust 嵌入推理核心         |
| `packages/embedding-napi`       | N-API 嵌入、SQLite 持久缓存、Rust top-k 索引        |
| `packages/mcp-rust`             | Windows stdio MCP JSON-RPC 与进程树管理网关         |
| `docs/project-guide.md`         | 项目架构、模块、协议和开发指南                      |
| `docs/rust-kernel-migration.md` | Rust 内核迁移边界与内存安全要求                     |

## 环境要求

- 开发环境需要 Node.js 24+ 和 npm 11+
- 构建 Rust sidecar 需要 Rust 1.85+ 和 Cargo
- 打包后的桌面端使用 Electron 自带 Node 运行时，不要求用户另装 Node

## 安装

```powershell
npm install
npm run build:rust
Copy-Item apps\backend\config.local.example.yaml apps\backend\config.local.yaml
```

API 密钥可以通过设置界面填写，也可以在启动前设置：

```powershell
$env:SOUL_MATE_MODEL__API_KEY = "sk-..."
```

不要把真实密钥提交到仓库。

## 启动

开发模式只需启动桌面端，桌面端会自动拉起后端：

```powershell
npm run dev:desktop
```

开发渲染地址固定为 `http://127.0.0.1:5300/`。启动脚本会自动清理 IDE
注入的 `ELECTRON_RUN_AS_NODE`，并修复 Windows 下 Electron 依赖的继承权限。

仅启动后端：

```powershell
npm run dev:backend
```

后端默认监听 `http://127.0.0.1:8000`。桌面端启动时会生成临时令牌，
HTTP 接口使用 Bearer 鉴权，WebSocket 必须先发送 `auth` 消息。

## 验证

```powershell
npm run typecheck
npm run test
npm run test:rust
npm run build
```

Rust 全目标静态检查：

```powershell
cargo clippy --manifest-path packages/agent-rust/Cargo.toml --all-targets -- -D warnings
```

嵌入性能对照：

```powershell
npm run bench:embedding -- D:/path/to/model
npm run bench:embedding:sidecar -- D:/path/to/model
```

构建可运行目录：

```powershell
npm run dist:dir -w soul-mate-frontend
```

生成 Windows 安装包：

```powershell
npm run dist -w soul-mate-frontend
```

## 配置

配置合并顺序：

```text
config.default.yaml
< config.local.yaml
< config.overrides.yaml
< SOUL_MATE_* 环境变量
```

嵌套配置使用双下划线，例如：

```powershell
$env:SOUL_MATE_FEATURES__MEMORY = "true"
```

## 当前限制

- 记忆与 RAG 使用中文词项检索、SQLite 持久向量缓存和 Rust 内存 top-k 索引；
  `auto` 模式优先加载 N-API，失败时自动回退 sidecar。
- Edge TTS 尚未内置；配置 GPT-SoVITS 后后端会优先通过其虚拟环境自动拉起
  本地服务，缺少虚拟环境时再用隔离缓存的 `uv` 回退。
- MCP 当前只支持 Windows stdio；Streamable HTTP 尚未接入。
- 滚动摘要、MCP 客户端和 Windows 代码签名仍待后续完善。
- TypeScript Agent 保留为故障回滚路径：把 `agent.kernel` 改为 `typescript`
  即可切换。

更完整的架构、数据流、接口和排查说明见
[项目详细文档](docs/project-guide.md)。
