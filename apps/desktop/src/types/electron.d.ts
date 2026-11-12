import type { BackendSnapshot, PickedTextFile, RestartResult } from "../../electron/types";

export type { BackendSnapshot, PickedTextFile, RestartResult };

/**
 * window.soulMate 的类型声明
 *
 * 类型源：electron/types.ts
 */
declare global {
    interface Window {
        soulMate: {
            getBackendStatus: () => Promise<BackendSnapshot>;
            restartBackend: () => Promise<RestartResult>;
            onBackendStatus: (callback: (snapshot: BackendSnapshot) => void) => () => void;

            openTextFile: () => Promise<PickedTextFile | null>;
        };
    }
}

export {};
