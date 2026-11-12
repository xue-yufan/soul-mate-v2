import { contextBridge, ipcRenderer } from "electron";

import type { BackendSnapshot, PickedTextFile } from "./types.ts";

contextBridge.exposeInMainWorld("soulMate", {
    getBackendStatus: () => ipcRenderer.invoke("backend:get-status"),

    restartBackend: () => ipcRenderer.invoke("backend:restart"),

    onBackendStatus: (callback: (snapshot: BackendSnapshot) => void) => {
        const listener = (_event: unknown, snapshot: BackendSnapshot): void => {
            callback(snapshot);
        };
        ipcRenderer.on("backend:status", listener);
        return () => ipcRenderer.removeListener("backend:status", listener);
    },

    // 新增：打开系统文件选择对话框，返回选中的绝对路径；用户取消返回 null
    openTextFile: (): Promise<PickedTextFile | null> => ipcRenderer.invoke("dialog:open-text-file"),
});
