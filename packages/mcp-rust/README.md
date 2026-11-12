# Rust MCP 工具网关

`soul-mate-mcp-rust` 是 Windows-first 的安全 Rust stdio MCP 网关。Node 后端
按启用的 MCP 服务各启动一个网关进程，Rust 再负责对应 MCP 子进程。

## 职责

- MCP JSON-RPC 2.0 换行 framing；
- `initialize`、`notifications/initialized` 和分页 `tools/list`；
- 并发 `tools/call`、调用取消和超时；
- 服务端 `ping`、`roots/list` 请求；
- stderr 有界采集和退出事件；
- MCP 子进程及进程树回收；
- 输入/输出/工具数量上限。

Node 后端继续负责：

- MCP 服务配置和工作目录；
- 工具 allowlist；
- 权限确认、审计和前端事件；
- 将 MCP annotations 映射为人格确认类别。

## 配置

```yaml
features:
  tools: true
  mcp: true

mcp:
  connect_timeout_s: 10
  call_timeout_s: 30
  max_tools: 40
  max_result_chars: 100000
  servers:
    - id: filesystem
      enabled: true
      transport: stdio
      command: C:/Path/To/mcp-server.exe
      args: ["D:/AllowedDir"]
      env: {}
      cwd: null
      tool_allowlist: ["read_text_file", "list_directory"]
```

当前只支持 `transport: stdio`。Streamable HTTP 不在 v2-C 范围内。
`command` 必须是 Windows 可直接启动的可执行文件，例如 `.exe` 或
`node.exe`；网关不经过 shell，因此 `.cmd` 批处理需要显式使用
`C:/Windows/System32/cmd.exe` 并自行传入受限参数。

## 构建与验证

```powershell
npm run build:rust-mcp
npm run test:rust
npm run test -w @soul-mate/backend
```

发布二进制：

```text
.tmp-cargo-target/release/soul-mate-mcp-rust.exe
```

Electron 打包后位于：

```text
resources/mcp-rust/soul-mate-mcp-rust.exe
```

`--mock-mcp-server` 只用于集成测试，会启动一个最小 stdio MCP 服务。
