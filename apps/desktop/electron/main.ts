import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    session,
    shell,
    type OpenDialogOptions,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BackendManager } from "./backend.ts";
import type { BackendSnapshot, PickedTextFile, RestartResult } from "./types.ts";

// 不用声明 __dirname：electron-vite 在 ESM 产物里会注入同名垫片，自己再声明会重复定义
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

/**
 * 窗口/任务栏图标。
 *
 * 打包版由 exe 自带的图标负责（electron-builder 从 build/icon.ico 打进去），
 * dev 下 exe 是 electron 自己的，所以这里显式指一下，免得调试时任务栏是 electron 的 logo。
 */
const windowIcon = path.join(moduleDir, "../../build/icon.ico");

let mainWindow: BrowserWindow | null = null;
let backend: BackendManager | null = null;

/**
 * 外链交给系统浏览器，页面本身不跳转
 *
 * 模型回复里的 Markdown 链接（渲染成 `<a href="https://…">`）如果直接导航，
 * 整个应用窗口会变成那个网页：没有后退键、没有菜单，用户只能重启应用。
 */
function installLinkGuard(win: BrowserWindow, devUrl: string | undefined): void {
    // 打包版是 file:// 页面（origin 是字符串 "null"），页面内不存在合法跳转；
    // 开发版放行 dev server 的同源导航（HMR 刷新、location.reload）
    let selfOrigin = "null";
    if (devUrl) {
        try {
            selfOrigin = new URL(devUrl).origin;
        } catch {
            selfOrigin = "null";
        }
    }

    const openInSystemBrowser = (url: string): void => {
        // 不写 = ""：catch 里直接 return，这个初值永远不会被读到
        let protocol: string;
        try {
            protocol = new URL(url).protocol;
        } catch {
            return;
        }
        if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
            return;
        }
        void shell.openExternal(url);
    };

    // window.open / target=_blank：不开新窗口
    win.webContents.setWindowOpenHandler(({ url }) => {
        openInSystemBrowser(url);
        return { action: "deny" };
    });

    win.webContents.on("will-navigate", (event, url) => {
        if (selfOrigin !== "null" && isSameOrigin(url, selfOrigin)) {
            return;
        }
        event.preventDefault();
        openInSystemBrowser(url);
    });
}

function isSameOrigin(url: string, origin: string): boolean {
    try {
        return new URL(url).origin === origin;
    } catch {
        return false;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: "Soul Mate",
        icon: fs.existsSync(windowIcon) ? windowIcon : undefined,
        backgroundColor: "#1a1a1f",
        webPreferences: {
            preload: path.join(moduleDir, "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    // dev 下由 electron-vite 起渲染层的 dev server，地址通过环境变量给出
    const rendererUrl = process.env["ELECTRON_RENDERER_URL"];

    if (isDev && rendererUrl) {
        mainWindow.loadURL(rendererUrl);
        mainWindow.webContents.openDevTools({ mode: "right" });
    } else {
        mainWindow.loadFile(path.join(moduleDir, "../renderer/index.html"));
    }

    if (isDev) {
        mainWindow.webContents.on("console-message", (event) => {
            const logLevel =
                event.level === "error" ? "错误" : event.level === "warning" ? "警告" : "信息";
            console.log(`[渲染层/${logLevel}] ${event.message}`);
        });
    }

    installLinkGuard(mainWindow, isDev ? rendererUrl : undefined);

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

/**
 * 只允许主窗口申请视频权限。
 *
 * 摄像头授权还需要用户点击顶栏按钮；这里拦的是 Electron 的媒体权限层，
 * 避免页面里的其他脚本顺带申请麦克风或让未知窗口拿到摄像头。
 */
function installCameraPermissions(): void {
    const ses = session.defaultSession;

    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const ownWindow =
            mainWindow !== null &&
            !mainWindow.isDestroyed() &&
            webContents.id === mainWindow.webContents.id;
        if (permission !== "media" || !ownWindow) {
            callback(false);
            return;
        }

        const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
        callback(mediaTypes.includes("video") && !mediaTypes.includes("audio"));
    });

    ses.setPermissionCheckHandler((webContents, permission, _origin, details) => {
        const ownWindow =
            mainWindow !== null &&
            !mainWindow.isDestroyed() &&
            webContents?.id === mainWindow.webContents.id;
        if (permission !== "media" || !ownWindow) {
            return false;
        }

        return !("mediaType" in details) || details.mediaType !== "audio";
    });
}

function setupBackend(): void {
    backend = new BackendManager({ isDev });

    // 状态变化推送到渲染进程
    backend.on("status", (snapshot: BackendSnapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("backend:status", snapshot);
        }
    });

    // 渲染进程主动查询
    ipcMain.handle("backend:get-status", (): BackendSnapshot => {
        if (!backend) {
            return {
                status: "stopped",
                error: "后端管理器未初始化",
                host: "127.0.0.1",
                port: 8000,
                token: "",
            };
        }
        return backend.getSnapshot();
    });

    // 渲染进程请求重启
    ipcMain.handle("backend:restart", async (): Promise<RestartResult> => {
        if (!backend) {
            return { ok: false, error: "后端管理器未初始化" };
        }
        try {
            await backend.stop();
            await backend.start();
            return { ok: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: message };
        }
    });

    // 异步启动，不阻塞窗口显示
    backend.start().catch((err: unknown) => {
        console.error("[主进程] 后端启动失败：", err);
    });
}

/**
 * 注册系统级对话框的 IPC handler。
 *
 * 文档导入由主进程在用户选定文件后直接读取，再把文本交给后端。
 * 后端不再接受任意本地路径，避免通过本地 HTTP API 读取未授权文件。
 */
function setupDialogs(): void {
    const options: OpenDialogOptions = {
        title: "选择要导入的文档",
        properties: ["openFile"],
        filters: [
            {
                name: "文本文件",
                extensions: ["txt", "md", "markdown", "json"],
            },
            { name: "Word 文档", extensions: ["docx"] },
            { name: "所有文件", extensions: ["*"] },
        ],
    };

    ipcMain.handle("dialog:open-text-file", async (): Promise<PickedTextFile | null> => {
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        const result = win
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options);

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        const file = result.filePaths[0];
        if (!file) return null;

        const stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error("选择的路径不是文件");
        if (stat.size > 16 * 1024 * 1024) {
            throw new Error("文件过大，当前上限为 16MB");
        }
        const raw = fs.readFileSync(file);
        if (raw.includes(0)) throw new Error("暂不支持导入二进制文件");

        let content: string;
        try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } catch {
            throw new Error("文件不是有效的 UTF-8 文本");
        }
        return {
            path: file,
            title: path.basename(file),
            content,
        };
    });
}

const BACKEND_MODE_FLAG = "--soul-mate-backend";

if (process.argv.includes(BACKEND_MODE_FLAG)) {
    // A packaged Electron executable runs our backend with its bundled Node
    // runtime. This avoids requiring Node 24 to be installed on the user's PATH.
    app.disableHardwareAcceleration();
    app.setPath(
        "userData",
        path.join(app.getPath("temp"), "soul-mate-backend", String(process.pid)),
    );
    const backendEntry = app.isPackaged
        ? path.join(process.resourcesPath, "backend", "dist", "server.mjs")
        : path.resolve(app.getAppPath(), "../backend/dist/server.mjs");
    void app
        .whenReady()
        .then(() => import(pathToFileURL(backendEntry).href))
        .catch((error: unknown) => {
            console.error("[后端子进程] 启动失败：", error);
            app.exit(1);
        });
} else {
    // 单实例：开出第二个应用会各拉一个后端、互相抢 8000，这里直接让后来的退出
    const hasSingleInstanceLock = app.requestSingleInstanceLock();

    if (!hasSingleInstanceLock) {
        app.quit();
    } else {
        // 第二个实例被拒后，用户再点一次图标时把已有窗口拎到前面
        app.on("second-instance", () => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                return;
            }
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        });

        app.whenReady().then(() => {
            setupDialogs();
            setupBackend();
            installCameraPermissions();
            createWindow();

            app.on("activate", () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    createWindow();
                }
            });
        });
    }

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            app.quit();
        }
    });

    // 退出前停后端
    let quitting = false;
    app.on("before-quit", (event) => {
        if (quitting || !backend) {
            return;
        }

        event.preventDefault();
        quitting = true;

        backend
            .stop()
            .catch((err: unknown) => {
                console.error("[主进程] 关闭后端失败：", err);
            })
            .finally(() => {
                app.quit();
            });
    });
}
