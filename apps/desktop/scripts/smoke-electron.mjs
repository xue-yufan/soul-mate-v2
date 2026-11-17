import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagedExe = path.join(
  desktopDir,
  "release",
  "win-unpacked",
  process.platform === "win32" ? "Soul Mate.exe" : "Soul Mate",
);
const electronExe = path.join(
  desktopDir,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const requirePackaged = process.argv.includes("--packaged");
const forceBuilt = process.argv.includes("--built");
const expectVoice = process.argv.includes("--expect-voice");
const usePackaged = !forceBuilt && fs.existsSync(packagedExe);

if (requirePackaged && !usePackaged) {
  throw new Error(`没有找到打包应用：${packagedExe}`);
}

const resourcesDir = usePackaged
  ? path.join(path.dirname(packagedExe), "resources")
  : null;
if (resourcesDir) {
  const required = [
    path.join(resourcesDir, "backend", "dist", "server.mjs"),
    path.join(resourcesDir, "agent-rust", "soul-mate-agent-rust.exe"),
    path.join(resourcesDir, "embedding-napi", "soul-mate-embedding.node"),
    path.join(resourcesDir, "mcp-rust", "soul-mate-mcp-rust.exe"),
    path.join(resourcesDir, "vision-opencv", "soul-mate-vision-opencv.exe"),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      throw new Error(`打包资源缺失：${file}`);
    }
  }
  const visionDir = path.join(resourcesDir, "vision-opencv");
  if (
    process.platform === "win32" &&
    !fs.readdirSync(visionDir).some((name) => /^opencv_world\d+\.dll$/i.test(name))
  ) {
    throw new Error(`OpenCV 运行库未打包：${visionDir}`);
  }
}

let packageCopyRoot = null;
let command = usePackaged ? packagedExe : electronExe;
if (!fs.existsSync(command)) {
  throw new Error(`Electron 可执行文件不存在：${command}`);
}
if (process.platform === "win32") {
  const permissionRoot = usePackaged
    ? path.dirname(packagedExe)
    : path.join(desktopDir, "node_modules", "electron");
  spawnSync("icacls", [permissionRoot, "/inheritance:e", "/T"], {
    stdio: "ignore",
    windowsHide: true,
  });
  spawnSync("icacls", [permissionRoot, "/setintegritylevel", "M", "/T"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (usePackaged && hasLowIntegrity(packagedExe)) {
    packageCopyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "soul-mate-package-"),
    );
    const launchRoot = path.join(packageCopyRoot, "win-unpacked");
    copyLaunchRoot(path.dirname(packagedExe), launchRoot);
    command = path.join(launchRoot, path.basename(packagedExe));
    console.log("打包目录继承 Low Integrity，已复制到临时目录后启动");
  }
}

const port = await availablePort();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-smoke-"));
const args = usePackaged
  ? []
  : [desktopDir];
args.push(
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--disable-gpu",
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_CRASHPAD_PIPE_NAME;
const child = spawn(command, args, {
  cwd: desktopDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
child.stdout.setEncoding("utf-8");
child.stderr.setEncoding("utf-8");
child.stdout.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-40_000);
});
child.stderr.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-40_000);
});

let client = null;
try {
  const target = await waitForTarget(port, child);
  client = await connectCdp(target.webSocketDebuggerUrl);
  const state = await waitForUI(client);
  if (
    !state.app ||
    !state.chat ||
    !state.voiceButton ||
    !state.connected ||
    !state.backendReady ||
    (expectVoice && !state.voiceEnabled)
  ) {
    throw new Error(`应用状态异常：${JSON.stringify(state)}`);
  }
  console.log(
    `Electron 烟雾测试通过：${usePackaged ? "打包应用" : "构建产物"}，` +
      `窗口标题=${state.title}`,
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n--- Electron 输出 ---\n${output}`,
    { cause: error },
  );
} finally {
  client?.close();
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  }
  await sleep(1_000);
  cleanupTemp(userDataDir);
  if (packageCopyRoot) {
    cleanupPackageCopy(packageCopyRoot);
  }
}

function cleanupTemp(target) {
  try {
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 30,
      retryDelay: 200,
    });
  } catch (error) {
    console.warn(`临时目录清理失败，可稍后手动删除：${target}`, error);
  }
}

function cleanupPackageCopy(root) {
  const launchRoot = path.join(root, "win-unpacked");
  if (fs.existsSync(launchRoot)) {
    for (const entry of fs.readdirSync(launchRoot, {
      withFileTypes: true,
    })) {
      const target = path.join(launchRoot, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          fs.unlinkSync(target);
        } catch (error) {
          console.warn(`目录联接清理失败：${target}`, error);
        }
      }
    }
  }
  cleanupTemp(root);
}

function hasLowIntegrity(file) {
  const result = spawnSync("icacls", [file], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return /Low Mandatory Level/i.test(result.stdout ?? "");
}

function copyLaunchRoot(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.symlinkSync(from, to, "junction");
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portNumber =
        typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(portNumber);
      });
    });
  });
}

async function waitForTarget(debugPort, process) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(`Electron 提前退出：${process.exitCode ?? process.signalCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(
          (target) => target.type === "page" && target.webSocketDebuggerUrl,
        );
        if (page) return page;
      }
    } catch {
      // Electron is still starting.
    }
    await sleep(250);
  }
  throw new Error("等待 Electron 调试端口超时");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("无法连接 Electron DevTools 协议")),
      { once: true },
    );
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    async send(method, params = {}) {
      const requestId = ++id;
      const result = new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
      });
      socket.send(JSON.stringify({ id: requestId, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function waitForUI(client) {
  await client.send("Runtime.enable");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const text = document.body?.innerText ?? "";
        return {
          title: document.title,
          app: Boolean(document.querySelector(".app")),
          chat: Boolean(document.querySelector(".chat")),
          voiceButton: Boolean(document.querySelector('[data-testid="voice-input"]')),
          voiceEnabled: !document.querySelector('[data-testid="voice-input"]')?.disabled,
          connected: text.includes("已连接"),
          backendReady: text.includes("后端 127.0.0.1"),
          text: text.slice(0, 500)
        };
      })()`,
      returnByValue: true,
    });
    const state = result.result?.value;
    if (
      state?.connected &&
      state?.backendReady &&
      (!expectVoice || state?.voiceEnabled)
    ) {
      return state;
    }
    await sleep(400);
  }
  throw new Error("等待主界面连接后端超时");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
