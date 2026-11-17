# Soul Mate v2 项目详细说明

## 1. 项目定位

Soul Mate v2 是一个本地优先的角色陪伴桌面应用。渲染层使用 Electron + Vue，
主进程负责窗口、权限、文件选择和后端生命周期，Fastify 后端负责模型请求、
Agent 循环、数据持久化和本地工具，Agent 内核通过版本化契约与宿主解耦。

项目目标是：

- 继续支持原有角色人格和桌面交互；
- 将后端从 Python 迁移到 TypeScript；
- 保持数据与模型接口在本地可控；
- 使用安全 Rust Agent sidecar 承载 Agent 热路径，并保留 TypeScript 回滚路径；
- 在普通 Windows 机器上通过 Electron 打包应用直接运行。

## 2. 总体架构

```text
Electron 主进程
  ├─ BrowserWindow / preload / IPC
  ├─ 本地文件选择
  ├─ Electron 权限控制
  └─ BackendManager
       └─ Fastify 后端（开发：tsx；打包：Electron 自带 Node）

Vue 渲染层
  ├─ App / ChatPanel / CharacterStage
  ├─ useChat / useWebSocket / useTts
  ├─ useVisionCamera
  └─ 知识库、设置与审计界面

Fastify 后端
  ├─ HTTP：配置、历史、记忆、文档、世界书、健康检查
  ├─ WebSocket：文字对话、工具确认、摄像头帧
  ├─ Rust Agent Sidecar（默认）
  ├─ TypeScript Agent Kernel（回滚）
  ├─ OpenAI 兼容模型适配器
  ├─ SQLite 持久化
  ├─ Rust MCP Gateway（Windows stdio）
  └─ 工具、视觉、OpenVINO/GPT-SoVITS TTS 适配器

Agent Contracts
  ├─ ModelPort
  ├─ HistoryPort
  ├─ RecallPort
  ├─ ToolHost
  └─ KernelIpcEnvelope / KernelHostCall
```

渲染层不直接访问文件系统，也不直接启动后端。后端默认只监听回环地址。

## 3. 工作区结构

```text
apps/
  desktop/                 Electron + Vue 桌面端
  backend/                 Fastify 后端
packages/
  agent-contracts/         跨语言 Agent 契约
  agent-ts/                TypeScript Agent 回滚实现
  agent-rust/              默认 Rust Agent 与嵌入 sidecar
  embedding-core/          Rust Agent/N-API 共用嵌入推理核心
  embedding-napi/          进程内 Rust N-API 嵌入模块
  mcp-rust/                Windows stdio MCP 网关
docs/
  project-guide.md         本文档
  migration-feasibility.md 迁移可行性
  rust-kernel-migration.md Rust 迁移边界
```

## 4. 核心运行流程

### 4.1 应用启动

1. Electron 主进程创建单实例锁和主窗口。
2. `BackendManager` 生成进程级随机令牌。
3. 后端开始监听 `127.0.0.1:8000`。
4. 渲染层读取后端状态、设置 HTTP 鉴权令牌并连接 WebSocket。
5. 设置面板和其他页面读取公开配置。

开发模式下 Vite 固定监听 `127.0.0.1:5300`。Windows 可能保留
`5144–5243` 端口，因此不使用 Vite 默认的 `5173`。

后端启动后会逐项输出关键模块状态：

- SQLite 是否可用及数据库位置
- 对话模型、API 地址和密钥是否配置
- Agent 内核类型
- 工具是否启用及允许目录数量
- 向量嵌入模型是否配置、文件是否完整、是否真正加载
- TTS 提供方、参考音频、本地引擎权重和 HTTP 服务是否可连接
- 视觉模型配置
- 开发环境中的 VRM 文件

`GET /health` 的 `checks.modules` 会返回同样的结构化状态。
嵌入模型由 Rust sidecar 实际加载并参与召回；sidecar 缺失或推理失败时会明确
标记并回退 SQLite 词项检索。

### 4.2 一轮聊天

```text
用户输入
  -> WebSocket text_input
  -> 写入用户消息
  -> 意图分类
  -> 加载摘要、相关记忆/资料和最近历史
  -> 模型流式输出
  -> 必要时调用工具并等待用户确认
  -> 保存助手/工具消息
  -> 计算成本并发送 run_finished
  -> 异步更新滚动摘要并提取长期记忆
```

流式事件包括：

- `run_started`
- `expert_selected`
- `emotion`
- `text_delta`
- `tool_call_started`
- `tool_confirm_request`
- `tool_result`
- `tool_denied`
- `run_finished`
- `error`

### 4.3 工具确认

需要确认的工具会发送 `tool_confirm_request`。前端显示“允许”和“拒绝”按钮，
并通过 `tool_confirm` 返回 `confirm_id`。后端用同一个连接和确认 ID 恢复工具
执行；用户也可以直接回复“可以”“好，准了”“不必了”等自然语言。含糊回复只
会产生一句澄清，不会启动新的 Agent 轮次。确认问句会作为 assistant 消息落库，
刷新历史后仍可看到。用户拒绝、超时、连接断开或 Agent 超时都会终止等待。

## 5. 桌面端

### 5.1 窗口与安全

- `contextIsolation=true`
- `nodeIntegration=false`
- renderer sandbox 开启
- 仅允许主窗口申请摄像头视频权限
- 外部链接交给系统浏览器，并限制协议
- renderer 配置严格 CSP
- 本地 API 使用进程级 Bearer 令牌
- WebSocket 在第一条业务消息前必须鉴权

### 5.2 preload 暴露的接口

- `getBackendStatus()`
- `restartBackend()`
- `onBackendStatus(callback)`
- `openTextFile()`

文件导入由主进程弹出用户文件选择框，再由主进程读取 UTF-8 文本。后端不再
接受任意绝对路径，避免本地 HTTP 接口被利用来读取未授权文件。

### 5.3 聊天状态

`useChat` 管理用户消息、流式助手消息、工具卡片、确认请求、历史分页和重新生成。

- 初次历史加载期间禁止发送，避免异步历史覆盖新消息。
- 工具确认同时支持显式按钮和自然语言回复；待确认期间输入框保持可用。
- 重新生成会先调用后端截断最后一轮，再重新发送原用户文本。
- 清空历史只有在后端成功后才清空界面。

### 5.4 VRM 3D 角色

模型文件：

```text
apps/desktop/public/model/character/xiadie.vrm
```

渲染流程：

1. `GLTFLoader` 加载 VRM。
2. `VRMLoaderPlugin` 读取 VRM 1.0 扩展。
3. `VRMUtils.removeUnnecessaryVertices` 优化网格。
4. 关闭蒙皮网格的视锥剔除，避免旋转时整体消失。
5. 计算模型包围盒并自动调整相机。
6. 使用 `RoomEnvironment` 和 `PMREMGenerator` 生成环境光照。
7. 使用 `NeutralToneMapping` 保留颜色和饱和度。
8. 将颜色贴图明确标记为 sRGB，线性数据贴图保持线性。
9. 用低强度环境光、半球光和方向光补充角色轮廓。
10. 每帧更新表情、眨眼、口型和 spring bone。

模型本身使用标准 PBR 材质和嵌入 PNG 贴图。若出现模型发白或无颜色，应优先
检查贴图颜色空间、色调映射、灯光过曝和材质是否被替换成无贴图材质。

模型加载完成后，浏览器控制台会输出网格、材质、颜色贴图数量和模型尺寸。
如果没有检测到颜色贴图，会输出明确警告。

## 6. 后端

后端入口为 `apps/backend/src/main.ts`，应用装配在 `src/app.ts`。

### 6.1 HTTP 接口

| 接口                           | 作用                     |
| ------------------------------ | ------------------------ |
| `GET /healthz`                 | 最小存活检查，不需要令牌 |
| `GET /health`                  | 数据库和运行时健康检查   |
| `GET /config/public`           | 安全的公开配置           |
| `PATCH /config`                | 更新白名单配置           |
| `GET/DELETE /history/messages` | 查询/清空历史            |
| `POST /history/regenerate`     | 截断最后一轮用于重新生成 |
| `GET /data/backup`             | 生成并下载完整 SQLite 备份 |
| `POST /system/shutdown`        | 桌面端请求后端优雅关闭   |
| `/memory/facts`                | 长期记忆 CRUD            |
| `/documents`                   | 文档导入、列表和切块查询 |
| `/worldbook`                   | 世界书 CRUD              |
| `/memory/audit`                | 记忆/工具审计            |

### 6.2 WebSocket

协议版本为 `1`。连接后先发送：

```json
{
  "v": 1,
  "type": "auth",
  "request_id": "auth",
  "data": { "token": "...", "client_id": "稳定的客户端 ID" }
}
```

桌面端从 IPC 获取令牌。普通独立后端调试如果未设置
`SOUL_MATE_LOCAL_TOKEN`，则不会启用令牌校验。

后端鉴权成功后发送 `auth_ok`。运行事件带有从 1 递增的 `seq`；浏览器网络中断
时会保留当前回合 30 秒，并使用同一个 `client_id` 发送：

```json
{
  "v": 1,
  "type": "resume_run",
  "request_id": "原回合 ID",
  "data": { "after_seq": 12 }
}
```

后端补发 `seq > after_seq` 的事件。正常结束后再保留两分钟，供刚断线的客户端
拿到 `run_finished`。超过恢复时限时运行被取消，并补发 `connection_lost`；
后端重启导致内存缓存丢失时发送 `run_not_found`，前端会从 SQLite 历史对账。

启用记忆或 RAG 但本地嵌入内核不可用时，后端会在当前连接第一次发送消息时
发送一次 `memory_unavailable` 错误事件；后续消息继续使用词项检索，不重复刷提示。

桌面端停止或重启后端时先调用受本地令牌保护的 `POST /system/shutdown`。后端向
所有 WebSocket 广播 `server_shutdown`，等待 `server.ws_notify_delay_s` 后关闭；
如果优雅停机请求失败，Electron 再按既有超时强制回收进程。

### 6.3 Agent 内核

当前 `TypeScriptAgentKernel` 负责：

- 规则和模型意图分类；
- 历史和召回上下文组装；
- 模型流式事件解析；
- 情绪标签处理；
- 最多 `max_tool_steps` 次工具循环；
- 取消、超时、工具拒绝和完整工具消息落库。

Agent 不直接访问 Fastify、SQLite 或 Electron，只通过端口调用宿主。

## 7. 数据持久化

默认数据库：

```text
apps/backend/data/soul_mate.db
```

主要表：

- `sessions`
- `messages`
- `session_summaries`
- `cost_log`
- `memory_facts`
- `documents`
- `document_chunks`
- `worldbook`
- `audit_log`

SQLite 使用 WAL、外键和事务。历史加载按完整用户轮次截取，避免把
assistant/tool 调用序列从中间截断后发送给模型。

滚动摘要默认按最近 6 轮估算 token，达到
`agent.summary_trigger_tokens` 后，把除最近
`agent.summary_keep_recent_turns` 轮之外的未摘要消息与已有摘要合并。摘要通过
`session_summaries.summarized_through_rowid` 记录水位，避免每轮重复压缩同一批
消息；模型生成失败时保留原摘要。摘要生成在 Node 宿主中异步执行，模型不可用
不影响当前轮回复。

数据库迁移由 `src/storage/migrations` 中的有序 SQL 文件驱动，版本同时记录在
`meta.schema_version`、`PRAGMA user_version` 和 `schema_migrations` 中。应用
拒绝打开高于当前版本支持的数据库；旧库升级前会先创建可校验的完整快照。

启动时会执行 `PRAGMA quick_check`，并在已有数据库上每天保留一份自动备份。
自动快照和迁移前备份位于数据目录的 `backups` 子目录，最多保留最近 10 份。
设置页「数据」可以导出单文件 SQLite 备份，也可以在停止后端、校验备份和保留
当前库副本后恢复；恢复后的启动失败会尝试自动回滚。

## 8. 工具、视觉与语音

### 8.1 内置工具

- `get_time`
- `get_weather`
- `read_file`
- `look_through_camera`

`read_file` 会解析真实路径，并在配置了允许目录时阻止 symlink 越界。

### 8.2 视觉

渲染层开启摄像头后声明 `camera` capability。后端请求单张 JPEG，前端压缩后
回传，后端再调用本地 Ollama 兼容视觉接口。摄像头轨道在连接断开或组件卸载时
会停止。

可选的 OpenCV C++ sidecar 用于验证单帧预处理是否值得进入正式视觉链路。默认
关闭；启用后，后端通过 NDJSON 启动一次独立进程，获取清晰度、亮度、对比度和
预处理图。sidecar 缺失、超时、非零退出或返回非法数据时自动使用原图，不影响
视觉模型调用。当前验证模块只做受限缩放、CLAHE 和轻量锐化，不包含 OCR、
透视校正或连续视频分析。构建命令为 `npm run build:vision-opencv`。发布构建
会把可执行文件和 `opencv_world*.dll` 一起放进 `resources/vision-opencv`。

### 8.3 语音

当前默认使用 Rust 本地 TTS sidecar 和 Piper VITS。后端按句切分并异步合成，
发送 base64 WAV；前端通过 Web Audio 播放并计算口型包络。`finish()` 会等待
正在合成的句子，避免最后一段音频被连接清理提前丢弃。

Rust sidecar 使用 ONNX Runtime 的 OpenVINO Execution Provider：CPU 运行声学
前端，GPU 运行卷积声码器。声码器按 64 帧分桶生成静态 ONNX，每个桶只编译一次；
本机缓存后同一句 HTTP 延迟约 0.12 秒。模型目录至少包含 `front.onnx`、
`decoder.onnx`、`tokens.txt` 和 `lexicon.txt`。

GPT-SoVITS 仍保留为可选 provider。选中 `gpt_sovits` 后，后端会探测并启动
本地 HTTP 服务；日志不输出 API 密钥。启动过程不阻塞 HTTP/WebSocket 就绪，
关闭后端时会一并关闭由应用启动的 TTS 子进程。

### 8.4 本地语音输入

顶栏麦克风使用 Web Audio 采集单声道音频，停止录音后线性重采样到 16 kHz
并编码为 16-bit PCM WAV，通过 `audio_input` 消息发送到后端。基础能量 VAD
会在检测到说话后等待 1.2 秒静音自动结束，单次最长 30 秒。

后端 `LocalAsr` 的 `auto` 顺序为 sherpa-onnx、whisper.cpp。显式配置了命令时
优先使用该命令；目录和参数不完整则继续尝试后续引擎。语音协议：

- 客户端 `audio_input`：Base64 WAV、采样率、时长。
- 服务端 `transcription_started`：实际引擎。
- 服务端 `transcription_result`：识别文本、引擎和耗时。
- 服务端 `transcription_error`：引擎缺失、音频格式、超时或执行失败。

识别成功后前端把文本交给原有 `chat.sendText()`，不会绕开历史、工具确认、
记忆和 TTS。引擎和模型由用户安装，仓库不附带二进制权重。详细配置与占位符见
[local-voice-asr.md](local-voice-asr.md)。

## 9. 配置

合并顺序：

```text
config.default.yaml
< config.local.yaml
< config.overrides.yaml
< SOUL_MATE_* 环境变量
```

环境变量使用双下划线表示层级：

```powershell
$env:SOUL_MATE_MODEL__API_KEY = "sk-..."
$env:SOUL_MATE_FEATURES__TOOLS = "true"
$env:SOUL_MATE_FEATURES__MEMORY = "true"
```

设置面板只允许修改白名单字段。密钥不会通过响应回显；被环境变量固定的字段
不能在界面覆盖。

## 10. 记忆和检索

当前检索使用 SQLite 词项和中文双字切分，综合：

- 查询覆盖率；
- 文本词项密度；
- 记忆重要性；
- 时间衰减；
- 世界书关键词加权。

文本候选先做词项评分，再通过 Rust Candle 加载本地 SentenceTransformer
safetensors，计算 384 维归一化向量并融合余弦相似度。默认 `auto` 模式优先
加载进程内 N-API 内核；N-API 缺失或推理失败时自动切到原有 sidecar。两者
共享同一份 `embedding-core` 推理代码。N-API 使用容量 4096 的 Rust LRU
缓存，不迁移旧 SQLite 或 Chroma 数据；sidecar 也不可用时回退纯词项检索。

向量同时写入 SQLite 的 `embedding_cache` 表。缓存键包含模型文件指纹和文本
哈希，不保存原文；模型变化会自动隔离旧向量。后端重启后直接加载 BLOB，不再
重新推理全部候选。Rust N-API 内维护常驻向量索引，查询时只返回语义 top-k
ID 和分数，候选向量不回到 JavaScript。

嵌入核心使用 padding + attention mask 做真正的 batch forward。召回前按
词项、boost 和时间权重做有界候选预过滤：记忆默认 512 条，RAG 默认 2048 条。
这避免在 ANN 引入前直接扫描无界候选集，但超大数据仍建议后续增加 ANN。

N-API 推理最多并行 2 路，等待队列上限 8。`RecallPort` 的 `AbortSignal` 会
传递到 N-API；Rust 在文本之间检查取消，并兼容“取消先于请求注册”的竞态。
模型加载和推理 panic 会被转换为错误，不会越过 FFI 终止 Electron 进程。

## 11. Rust 迁移

Agent 热路径已经迁移到默认的 `soul-mate-agent-rust` sidecar。`agent.kernel`
默认为 `rust`；可执行文件留空时，后端会依次查找环境变量、开发构建目录和
Electron `resources/agent-rust`。TypeScript Agent 仍可通过
`agent.kernel=typescript` 启用。

同一个 Rust 二进制有两种模式：

- 无参数：Agent NDJSON 服务；
- `--model-dir <目录>`：本地 Candle 嵌入服务。

Rust v2-A 增加了独立 N-API 嵌入模块：

- `packages/embedding-core` 保存共用模型加载、归一化和 LRU 缓存；
- `packages/embedding-napi` 输出 `soul-mate-embedding.node`；
- `embedding.kernel=auto` 默认优先 N-API；
- `embedding.kernel=napi` 可强制原生模块；
- `embedding.kernel=sidecar` 可固定旧进程方案；
- Native 初始化或推理失败时，`auto` 会自动回退 sidecar。
- `/health` 会返回内核状态机、加载耗时、推理平均耗时、缓存命中/未命中、
  活动/排队请求及失败计数。

Rust Agent 负责：

- 意图路由和 Prompt 组装；
- 模型流式响应和工具循环；
- 多运行 `run_id` 路由、运行超时和取消；
- `host_call/host_result` 协议与有界流通道；
- stdin 关闭、`shutdown` 和异常退出清理。

Node/Electron 继续持有：

- 模型 HTTP；
- SQLite；
- 工具执行；
- 用户确认；
- 日志和配置；
- 进程关闭。

Rust v2-C 增加 Windows stdio MCP 网关：

- Rust 负责 MCP 子进程、JSON-RPC 2.0、工具发现、调用、超时和取消；
- 每个配置的服务使用一个 `soul-mate-mcp-rust` 网关进程；
- Windows 使用 `taskkill /T /F` 回收 MCP 进程树；
- Node 继续持有服务配置、工具 allowlist、权限确认和审计；
- 工具以 `mcp__<server>__<tool>` 名称暴露给所有专家；
- MCP annotations 映射为 `mcp_read`、`mcp_network`、`mcp_write` 或
  `mcp_execute` 确认类别；
- 当前明确不支持 Streamable HTTP，配置为非 `stdio` 的服务会被跳过并记录日志。

`KernelHostCall` 和 `KernelHostResult` 是跨进程调用契约。本阶段不把模型
HTTP、SQLite、工具执行或权限确认迁入 N-API。一个调用的多个流块
会持续复用同一调用 ID，直到 `done=true` 或 `ok=false`。详细协议、取消和内存
安全要求见
[rust-kernel-migration.md](rust-kernel-migration.md)。

## 12. 开发、构建与打包

### 开发

```powershell
npm install
npm run dev:desktop
```

后端会自动启动。渲染开发服务器固定为：

```text
http://127.0.0.1:5300/
```

### 检查

```powershell
npm run typecheck
npm run test
npm run lint -w soul-mate-frontend
npm run format:check -w soul-mate-frontend
npm run build
npm run build:release
npm run smoke:electron
```

完整发布验证可先运行 `npm run dist:dir -w soul-mate-frontend`，再运行
`npm run smoke:dist`。烟雾测试会校验 Rust、N-API、MCP、OpenCV 资源，并启动
Electron 等待后端和 WebSocket 就绪。

### 打包

```powershell
npm run dist:dir -w soul-mate-frontend
npm run dist -w soul-mate-frontend
```

输出目录：

```text
apps/desktop/release/
```

打包版后端由 Electron 可执行文件以 `--soul-mate-backend` 子模式启动，因此不
依赖用户系统安装 Node.js。

## 13. 常见问题

### 开发端口 EACCES

Windows 可能保留 `5173` 所在端口范围。项目已固定使用 `5300`。

### Electron 启动返回 2147483651

该值对应 `0x80000003`。开发启动脚本会：

1. 删除 IDE 泄漏的 `ELECTRON_RUN_AS_NODE` 和 `CHROME_CRASHPAD_PIPE_NAME`；
2. 显式指定 Electron 二进制路径；
3. 修复 Electron 依赖目录的继承权限和完整性级别。

### 模型没有颜色

检查：

- `xiadie.vrm` 是否存在；
- 浏览器控制台是否提示贴图加载失败；
- renderer 是否启用了 sRGB 输出；
- 颜色贴图是否使用 `SRGBColorSpace`；
- 灯光是否过亮导致颜色截断；
- 是否误用了没有贴图的替代材质。

当前渲染配置已经包含环境光照、中性色调映射、sRGB 贴图校正和降低后的灯光强度。

### 工具确认一直等待

确认前端发送的是 `tool_confirm`，而不是普通 `text_input`。普通聊天消息在 Agent
忙碌时会被后端判定为 `busy`；如果当前连接确实有一个等待中的工具确认，后端会
优先把“可以 / 不必了”等明确回复解析为权限答复。

## 14. 当前限制

- MCP Streamable HTTP 尚未接入。
- Edge TTS 未内置。
- MCP 目前只支持 Windows stdio。
- 回合补发缓存位于内存：后端进程重启后依靠 SQLite 历史对账，不恢复未落库的半成品。
- 本地语音识别当前每次录音启动一次引擎进程，尚未实现常驻流式部分转写。
- TTS 声码器可以显式切到 NPU，但本机实测每 64 帧约 11 秒，当前不适合实时
  对话；默认使用 GPU。
- Windows 安装包尚未配置正式代码签名。
