import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import { checkpointDatabase, removeSidecarFiles, validateDatabaseFile } from "./database-files.ts";
import type {
  BackendSnapshot,
  BackendStatus,
  DataBackupResult,
  DataRestoreResult,
} from "./types.ts";
import { loadUserConfig, prepareDataDir, userConfigToEnv } from "./userConfig.ts";

const BACKEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "backend")
  : path.resolve(app.getAppPath(), "../backend");
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8000;
const TSX_CLI = path.resolve(app.getAppPath(), "../../node_modules/tsx/dist/cli.mjs");
const HEALTH_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/healthz`;
const BACKEND_APP_NAME = "soul-mate-backend";
const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const HEALTH_PROBE_TIMEOUT_MS = 1500;
const DATA_TRANSFER_TIMEOUT_MS = 120_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 1500;
const STATUS_LABELS: Record<BackendStatus, string> = {
  starting: "启动中",
  ready: "已就绪",
  stopped: "已停止",
  error: "异常",
};

interface HealthBody {
  status?: string;
  app?: string;
  version?: string;
  pid?: number;
  boot_id?: string;
  checks?: {
    database?: {
      path?: string;
      schema_version?: string;
    };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isOurBackend(body: HealthBody | null): boolean {
  return Boolean(body && (body.app === BACKEND_APP_NAME || body.boot_id));
}

/**
 * Launches the TypeScript backend.
 *
 * Development uses the workspace `tsx` executable so source changes are visible
 * without a separate build. Packaged builds run the bundled server with a
 * Node 24 runtime. `SOUL_MATE_NODE_EXE` can still point at an external runtime
 * for diagnostics; the default uses the app executable in backend-only mode.
 */
export class BackendManager extends EventEmitter {
  private readonly isDev: boolean;
  private proc: ChildProcess | null = null;
  private stopping = false;
  private status: BackendStatus = "stopped";
  private lastError: string | null = null;
  private ownedBootId: string | null = null;
  private readonly localToken = crypto.randomBytes(32).toString("base64url");

  constructor({ isDev }: { isDev: boolean }) {
    super();
    this.isDev = isDev;
  }

  async start(): Promise<void> {
    this.lastError = null;
    this.setStatus("starting");
    await this.evictStaleBackend();

    const userConfig = loadUserConfig();
    const dataDir = prepareDataDir(userConfig);
    this.spawnBackend(userConfig, dataDir);
    const health = await this.waitForHealth();
    if (!health) {
      this.lastError = "后端启动超时";
      this.setStatus("error");
      throw new Error(this.lastError);
    }
    this.ownedBootId = health.boot_id ?? null;
    this.setStatus("ready");
  }

  async stop(): Promise<void> {
    if (!this.proc) {
      this.setStatus("stopped");
      return;
    }
    const proc = this.proc;
    this.stopping = true;
    await new Promise<void>((resolve, reject) => {
      const forceTimer = setTimeout(() => {
        this.killTree(proc);
      }, STOP_TIMEOUT_MS);
      const deadlineTimer = setTimeout(() => {
        cleanup();
        this.stopping = false;
        this.lastError = "后端进程未能按时退出";
        this.setStatus("error");
        reject(new Error("后端进程未能按时退出，已中止数据替换"));
      }, STOP_TIMEOUT_MS + 5_000);
      const cleanup = (): void => {
        clearTimeout(forceTimer);
        clearTimeout(deadlineTimer);
      };
      proc.once("exit", () => {
        cleanup();
        this.proc = null;
        this.stopping = false;
        this.ownedBootId = null;
        this.setStatus("stopped");
        resolve();
      });
      void this.requestGracefulShutdown().then((accepted) => {
        if (!accepted) this.killTree(proc);
      });
    });
  }

  async exportDatabase(destination: string): Promise<DataBackupResult> {
    if (this.status !== "ready" || !this.proc) {
      return { ok: false, error: "后端尚未就绪" };
    }
    const staged = `${destination}.download-${process.pid}-${Date.now()}.tmp`;
    try {
      const response = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}/data/backup`, {
        headers: {
          Authorization: `Bearer ${this.localToken}`,
        },
        signal: AbortSignal.timeout(DATA_TRANSFER_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        return { ok: false, error: detail };
      }
      const data = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(staged, data);
      validateDatabaseFile(staged);
      fs.rmSync(destination, { force: true });
      fs.renameSync(staged, destination);
      return { ok: true, path: destination };
    } catch (error) {
      fs.rmSync(staged, { force: true });
      return { ok: false, error: errorMessage(error) };
    }
  }

  async restoreDatabase(sourcePath: string): Promise<DataRestoreResult> {
    const source = path.resolve(sourcePath);
    let staged: string | null = null;
    let safetyBackup: string | null = null;
    let databasePath: string | null = null;

    try {
      validateDatabaseFile(source);
      const health = await this.probeDetailedHealth();
      databasePath = health?.checks?.database?.path ?? null;
      if (this.status !== "ready" || !this.proc || !databasePath) {
        return { ok: false, error: "无法确定当前数据库位置，后端尚未就绪" };
      }
      if (path.resolve(databasePath) === source) {
        return { ok: false, error: "不能从当前正在使用的数据库文件恢复" };
      }

      await this.stop();
      checkpointDatabase(databasePath);
      const backupDir = path.join(path.dirname(databasePath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      safetyBackup = path.join(backupDir, `before-restore-${fileTimestamp(new Date())}.db`);
      fs.copyFileSync(databasePath, safetyBackup);
      validateDatabaseFile(safetyBackup);

      staged = `${databasePath}.restore-${process.pid}-${Date.now()}.tmp`;
      fs.copyFileSync(source, staged);
      validateDatabaseFile(staged);
      removeSidecarFiles(databasePath);
      fs.rmSync(databasePath, { force: true });
      fs.renameSync(staged, databasePath);
      staged = null;

      await this.start();
      return { ok: true, path: databasePath };
    } catch (error) {
      const restoreError = errorMessage(error);
      if (staged) {
        fs.rmSync(staged, { force: true });
      }

      if (safetyBackup && databasePath && fs.existsSync(safetyBackup)) {
        try {
          await this.stop();
          removeSidecarFiles(databasePath);
          fs.copyFileSync(safetyBackup, databasePath);
          await this.start();
          return {
            ok: false,
            error: `恢复失败，已回滚到恢复前数据：${restoreError}`,
          };
        } catch (rollbackError) {
          return {
            ok: false,
            error: `恢复失败且自动回滚失败：${restoreError}；${errorMessage(rollbackError)}`,
          };
        }
      }
      return { ok: false, error: restoreError };
    }
  }

  getSnapshot(): BackendSnapshot {
    return {
      status: this.status,
      error: this.lastError,
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      token: this.localToken,
    };
  }

  private setStatus(status: BackendStatus): void {
    if (this.status === status) return;
    this.status = status;
    console.log(`[后端] 状态：${STATUS_LABELS[status]}`);
    this.emit("status", this.getSnapshot());
  }

  private spawnBackend(
    userConfig: ReturnType<typeof loadUserConfig>,
    dataDir: string | null,
  ): void {
    let command: string;
    let args: string[];
    if (this.isDev) {
      command = process.execPath;
      args = [TSX_CLI, "src/main.ts"];
    } else {
      const externalNode = process.env.SOUL_MATE_NODE_EXE?.trim();
      command = externalNode || process.execPath;
      args = externalNode
        ? [path.join(BACKEND_DIR, "dist", "server.mjs")]
        : ["--soul-mate-backend"];
    }

    const userEnv = userConfigToEnv(userConfig);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SOUL_MATE_APP__ENV: this.isDev ? "dev" : "prod",
      SOUL_MATE_PARENT_PID: String(process.pid),
      SOUL_MATE_LOCAL_TOKEN: this.localToken,
      ...(dataDir ? { SOUL_MATE_PATHS__DATA_DIR: dataDir } : {}),
      ...userEnv,
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (this.isDev) {
      childEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    console.log(`[后端] 正在启动：${command} ${args.join(" ")}（工作目录：${BACKEND_DIR}）`);
    this.stopping = false;
    this.proc = spawn(command, args, {
      cwd: BACKEND_DIR,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[backend] ${data.toString()}`);
    });
    this.proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[backend] ${data.toString()}`);
    });
    this.proc.on("error", (error) => {
      this.lastError = error.message;
      this.setStatus("error");
    });
    this.proc.on("exit", (code, signal) => {
      console.log(`[后端] 进程退出：退出码=${code}，信号=${signal}`);
      this.proc = null;
      if (!this.stopping && this.status !== "stopped") {
        this.lastError = `后端异常退出：code=${code}`;
        this.setStatus("error");
      }
    });
  }

  private async probeHealth(): Promise<{
    reachable: boolean;
    body: HealthBody | null;
  }> {
    try {
      const response = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      let body: HealthBody | null = null;
      try {
        body = (await response.json()) as HealthBody;
      } catch {
        body = null;
      }
      return { reachable: true, body };
    } catch {
      return { reachable: false, body: null };
    }
  }

  private async requestGracefulShutdown(): Promise<boolean> {
    try {
      const response = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}/system/shutdown`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.localToken}`,
        },
        signal: AbortSignal.timeout(SHUTDOWN_REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async probeDetailedHealth(): Promise<HealthBody | null> {
    try {
      const response = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}/health`, {
        headers: {
          Authorization: `Bearer ${this.localToken}`,
        },
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS * 2),
      });
      return response.ok ? ((await response.json()) as HealthBody) : null;
    } catch {
      return null;
    }
  }

  private async evictStaleBackend(): Promise<void> {
    const probe = await this.probeHealth();
    if (!probe.reachable) return;
    if (probe.body && this.ownedBootId && probe.body.boot_id === this.ownedBootId) {
      return;
    }
    if (!isOurBackend(probe.body)) {
      throw new Error(`端口 ${BACKEND_PORT} 已被其他程序占用`);
    }
    const pid = probe.body?.pid;
    if (!pid || pid <= 0) {
      throw new Error(`端口 ${BACKEND_PORT} 上的旧后端没有上报 pid`);
    }
    this.killPid(pid);
    for (let i = 0; i < 20; i += 1) {
      await sleep(200);
      if (!(await this.probeHealth()).reachable) return;
    }
    throw new Error(`端口 ${BACKEND_PORT} 上的旧后端无法关闭`);
  }

  private killPid(pid: number): void {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  private killTree(proc: ChildProcess): void {
    if (process.platform === "win32" && proc.pid) {
      this.killPid(proc.pid);
      return;
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  private async waitForHealth(): Promise<HealthBody | null> {
    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      if (!this.proc) return null;
      const probe = await this.probeHealth();
      if (probe.reachable && probe.body?.status === "ok") {
        return probe.body;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }
}

// Preserve the public methods used by electron/main.ts while making startup
// failures visible in the renderer.
export function backendRuntimeExists(): boolean {
  return fs.existsSync(
    app.isPackaged
      ? path.join(process.resourcesPath, "backend", "dist", "server.mjs")
      : path.resolve(app.getAppPath(), "../backend", "src", "main.ts"),
  );
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : `备份请求失败：HTTP ${response.status}`;
  } catch {
    return `备份请求失败：HTTP ${response.status}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
