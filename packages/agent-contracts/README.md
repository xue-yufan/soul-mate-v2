# Agent contracts

This package is the stable boundary between the backend host and an agent kernel.

The current kernel is implemented in TypeScript by `@soul-mate/agent-ts`. The same
contracts are intended for a future Rust sidecar:

- a versioned request/event protocol (`AGENT_CONTRACT_VERSION`);
- model, history, recall and tool access exposed as host ports;
- tool execution and confirmation kept outside the kernel;
- no dependency on Fastify, SQLite, Electron or a particular model SDK.

When adding a field, prefer an optional field and keep old readers working. A
breaking shape change requires a new contract version.
