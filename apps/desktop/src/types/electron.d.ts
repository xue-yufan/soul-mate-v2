import type {
  BackendSnapshot,
  DataBackupResult,
  DataRestoreResult,
  PickedTextFile,
  RestartResult,
} from "../../electron/types";

export type { BackendSnapshot, DataBackupResult, DataRestoreResult, PickedTextFile, RestartResult };

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
      exportDataBackup: () => Promise<DataBackupResult>;
      restoreDataBackup: () => Promise<DataRestoreResult>;
      onBackendStatus: (callback: (snapshot: BackendSnapshot) => void) => () => void;

      openTextFile: () => Promise<PickedTextFile | null>;
    };
  }
}

export {};
