import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import type { BackendSnapshot, BackendStatus } from "./types.ts";
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
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                this.killTree(proc);
                resolve();
            }, STOP_TIMEOUT_MS);
            proc.once("exit", () => {
                clearTimeout(timeout);
                this.proc = null;
                this.stopping = false;
                this.ownedBootId = null;
                this.setStatus("stopped");
                resolve();
            });
            if (process.platform === "win32") this.killTree(proc);
            else proc.kill("SIGTERM");
        });
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
