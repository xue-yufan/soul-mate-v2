import readline from "node:readline";

const VERSION = 1;
const pending = new Map();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendEvent(runId, type, data) {
  send({
    v: VERSION,
    id: runId,
    run_id: runId,
    kind: "agent_event",
    payload: { type, data },
  });
}

function sendError(runId, code, message) {
  sendEvent(runId, "error", { code, message });
}

function hostCall(runId, suffix, method, payload) {
  const id = `${runId}:${suffix}`;
  pending.set(id, { runId, method, chunks: [], events: [] });
  send({
    v: VERSION,
    id,
    run_id: runId,
    kind: "host_call",
    method,
    payload,
  });
}

function finishHostCall(id, state, terminalText) {
  if (state.method === "model.stream") {
    sendEvent(state.runId, "emotion", { emotion: "neutral" });
    for (const chunk of state.chunks) {
      if (chunk.delta) {
        sendEvent(state.runId, "text_delta", { text: chunk.delta });
      }
    }
    sendEvent(state.runId, "run_finished", {
      text: state.chunks.map((chunk) => chunk.delta ?? "").join(""),
      tokens_in: 2,
      tokens_out: 3,
      model: "fake-model",
      messages: [],
    });
  } else {
    for (const event of state.events) {
      sendEvent(state.runId, event.type, event.data);
    }
    sendEvent(state.runId, "run_finished", {
      text: terminalText,
      tokens_in: 0,
      tokens_out: 0,
      model: "fake-model",
      messages: [],
    });
  }
  pending.delete(id);
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind === "ping") {
    send({
      v: VERSION,
      id: message.id,
      kind: "pong",
      payload: { service: "rust-agent-fixture", protocol: VERSION },
    });
    return;
  }
  if (message.kind === "shutdown") {
    process.exit(0);
  }
  if (message.kind === "cancel") {
    sendError(message.run_id ?? message.id, "cancelled", "生成被取消");
    return;
  }
  if (message.kind === "run") {
    const runId = message.id;
    const text = message.payload.input.text;
    sendEvent(runId, "run_started", {});
    if (text.includes("exit")) {
      setTimeout(() => process.exit(23), 10);
      return;
    }
    if (text.includes("cancel")) {
      return;
    }
    if (text.includes("tools")) {
      hostCall(runId, "tool", "tools.execute", {
        call: { id: `${runId}:call`, name: "fixture", arguments: "{}" },
        expert: "chat",
      });
      return;
    }
    hostCall(runId, "model", "model.stream", {
      messages: [{ role: "user", content: text }],
      tools: [],
    });
    return;
  }
  if (message.kind === "host_result") {
    const state = pending.get(message.id);
    if (!state) return;
    if (message.payload.ok === false) {
      const messageText = String(message.payload.error ?? "");
      const cancelled = /abort|cancel|取消/i.test(messageText);
      sendError(
        state.runId,
        cancelled ? "cancelled" : "internal_error",
        cancelled ? "生成被取消" : messageText,
      );
      pending.delete(message.id);
      return;
    }
    if (state.method === "model.stream" && message.payload.chunk) {
      state.chunks.push(message.payload.chunk);
    } else if (state.method === "tools.execute" && message.payload.chunk) {
      state.events.push(message.payload.chunk);
    }
    if (message.payload.done === true) {
      finishHostCall(message.id, state, "工具流程完成");
    }
  }
});
