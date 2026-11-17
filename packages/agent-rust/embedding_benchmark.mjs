import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(packageDir, "../..");
const executable =
  process.platform === "win32"
    ? "soul-mate-agent-rust.exe"
    : "soul-mate-agent-rust";
const binary = path.join(
  workspaceDir,
  ".cargo-target",
  "release",
  executable,
);
const modelDir = process.argv[2] ?? process.env.SOUL_MATE_EMBED_MODEL_DIR;
if (!modelDir) {
  console.error(
    "用法：npm run bench:embedding:sidecar -- <模型目录>，或设置 SOUL_MATE_EMBED_MODEL_DIR",
  );
  process.exit(2);
}

const started = performance.now();
const child = spawn(binary, ["--model-dir", modelDir], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stderr.resume();
const pending = new Map();
let sequence = 0;
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    return;
  }
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  if (response.kind === "error") {
    request.reject(new Error(response.payload?.message ?? "sidecar 请求失败"));
  } else {
    request.resolve({ payload: response.payload, elapsed: performance.now() });
  }
});

function request(kind, payload) {
  const id = `sidecar-benchmark-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("sidecar 基准请求超时"));
    }, 120_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ v: 1, id, kind, payload })}\n`);
  });
}

async function timed(operation) {
  const before = performance.now();
  const result = await operation();
  return { result, ms: performance.now() - before };
}

try {
  const ping = await request("ping", {});
  const loadMs = ping.elapsed - started;
  await request("embed", { texts: ["预热 1", "预热 2", "预热 3", "预热 4"] });
  const texts = Array.from(
    { length: 16 },
    (_, index) => `记忆与检索基准文本 ${index}：今天的心情和天气`,
  );
  const cold = await timed(() => request("embed", { texts }));
  const cached = await timed(() => request("embed", { texts }));
  const concurrentTexts = [0, 1].map((group) =>
    Array.from(
      { length: 8 },
      (_, index) =>
        `并发基准 ${group}-${index}：角色记忆、情绪和资料检索 ${Date.now()}`,
    ),
  );
  const concurrent = await timed(() =>
    Promise.all(
      concurrentTexts.map((items) => request("embed", { texts: items })),
    ),
  );

  console.log(
    JSON.stringify(
      {
        binary,
        modelDir,
        dimension: ping.payload.dimension,
        loadMs,
        batch16ColdMs: cold.ms,
        batch16CachedMs: cached.ms,
        concurrent2x8Ms: concurrent.ms,
        speedup: cold.ms / Math.max(cached.ms, 0.001),
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.write(
    `${JSON.stringify({ v: 1, id: "shutdown", kind: "shutdown", payload: {} })}\n`,
  );
  child.stdin.end();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timer = setTimeout(() => child.kill(), 2_000);
  await exited;
  clearTimeout(timer);
}
