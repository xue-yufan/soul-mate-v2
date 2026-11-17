# Python -> TypeScript migration feasibility

## Conclusion

The migration is feasible. The old backend is mostly explicit application code:
FastAPI routes, WebSocket envelopes, SQLite tables, OpenAI-compatible HTTP
streaming, tool permissions and prompt construction. None of these require
Python.

The highest-risk areas are not the Agent loop itself. They are the external
capabilities that depended on the Python ecosystem:

| Capability                                 | v2 status                                                     | Assessment                               |
| ------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------- |
| HTTP API, health, config                   | Ported to Fastify                                             | Straightforward                          |
| WebSocket contract                         | Ported, version 1 preserved                                   | Straightforward                          |
| SQLite history/audit/cost                  | Ported with `node:sqlite`                                     | Requires Node >= 24                      |
| OpenAI-compatible streaming                | Ported with native `fetch`                                    | Straightforward                          |
| Supervisor / chat / info / tools           | Ported as a lightweight state machine                         | Straightforward                          |
| Tool confirmation and camera frame request | Ported                                                        | Packaging smoke test added               |
| Documents/worldbook/memory CRUD            | Ported                                                        | Straightforward                          |
| Semantic memory + Chroma                   | Lexical retrieval plus Rust N-API embeddings/sidecar fallback | No old Chroma data migration             |
| Per-turn memory extraction                 | Ported through the model                                      | Quality depends on model JSON compliance |
| Context summarization                      | Rolling summary with persisted message watermark              | Ported                                   |
| MCP client                                 | Windows stdio gateway in Rust; HTTP transport remains absent  | No external MCP SDK dependency           |
| Local neural TTS                           | Rust sidecar + ONNX Runtime OpenVINO EP                       | No Python runtime dependency             |
| GPT-SoVITS TTS                             | Ported over HTTP                                              | Requires a running local engine          |
| Edge TTS                                   | Not bundled in this version                                   | Largest TTS parity gap                   |
| Optional C++ sentence boundary             | Pure TypeScript implementation                                | More portable, slower on extreme inputs  |

The result is a working TypeScript baseline for normal chat and tool use, not a
claim of byte-for-byte parity for every optional subsystem.

## Why not copy LangGraph

The current graph has four nodes and a small number of fixed routes. A direct
state machine is easier to audit and is language-neutral. The TypeScript kernel
retains the same responsibilities:

```text
run_started
  -> rule/model intent routing
  -> chat or info prompt
  -> stream text and emotion
  -> tool host (permission + execution)
  -> same expert until no tool calls
  -> run_finished / error
```

This also avoids tying the Rust implementation to a JavaScript graph runtime.

## Rust upgrade boundary

`packages/agent-contracts` defines the stable types:

- `AgentKernel`;
- `ModelPort`, `HistoryPort`, `RecallPort`, `ToolHost`;
- versioned `AgentEvent` and `KernelIpcEnvelope`.

The backend selects the kernel through `agent.kernel`:

```yaml
agent:
  kernel: rust # rust | typescript rollback
  rust_command: ""
  rust_args: []
```

`RustSidecarKernel` uses NDJSON/stdio transport with per-run cancellation and
`host_call`/`host_result` multiplexing. The executable is built by
`npm run build:rust` and bundled under `resources/agent-rust`. Enabling `rust`
without an executable fails loudly instead of silently selecting a different
implementation.

SQLite, model HTTP and tool execution remain in the Node host. The Rust sidecar
owns routing, prompt assembly and the streaming tool loop, and calls the host
through versioned RPC. This prevents dual SQLite writers and allows an instant
rollback by changing one config value.

## Migration and verification plan

1. Run both backends against the same captured WebSocket fixtures.
2. Compare event order, error codes and persisted rows.
3. Exercise one normal chat, one tool confirmation, one denial, one timeout and
   one reconnect.
4. Run the existing frontend test suite against the unchanged renderer.
5. Chroma/embedding replacement now uses a native N-API module with the existing
   sidecar retained as a compatibility fallback.

## Security notes

- No `config.local.yaml`, `.env`, API key, runtime database, Chroma index or log
  was copied into v2.
- The frontend public model assets are copied as-is because they are runtime
  assets, not source dependencies.
- The settings API returns only `api_key_set`, never the key value.
- Desktop-managed backend processes require an ephemeral bearer token; packaged
  builds run the backend with Electron's bundled Node runtime.
- Tool arguments are sent to the renderer for confirmation but tool result audit
  rows store only status/size/error metadata.
