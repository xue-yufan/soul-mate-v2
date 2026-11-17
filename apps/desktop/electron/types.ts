export type BackendStatus = "starting" | "ready" | "stopped" | "error";

export interface BackendSnapshot {
  status: BackendStatus;
  error: string | null;
  host: string;
  port: number;
  /** Renderer-only ephemeral token for the loopback API. */
  token: string;
}

export interface RestartResult {
  ok: boolean;
  error?: string;
}

export interface DataBackupResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

export interface DataRestoreResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

export interface PickedTextFile {
  path: string;
  title: string;
  content: string;
}
