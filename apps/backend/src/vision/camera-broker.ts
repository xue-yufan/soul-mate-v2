import crypto from "node:crypto";

export interface CameraFrame {
  image: Buffer;
  mimeType: string;
}

interface CameraClient {
  readonly id: string;
  sendCaptureRequest(event: {
    captureId: string;
    question: string;
    reason: string;
    timeoutS: number;
  }): boolean;
}

interface PendingCapture {
  client: CameraClient;
  resolve: (frame: CameraFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CameraBroker {
  private readonly clients = new Map<string, CameraClient>();
  private readonly pending = new Map<string, PendingCapture>();

  register(client: CameraClient | null): void {
    if (client) this.clients.set(client.id, client);
  }

  unregister(client: CameraClient): void {
    if (this.clients.get(client.id) !== client) return;
    this.clients.delete(client.id);
    for (const [id, pending] of this.pending) {
      if (pending.client.id !== client.id) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error("摄像头连接已断开"));
    }
  }

  hasCameraClient(): boolean {
    return this.clients.size > 0;
  }

  async requestCapture(options: {
    requestId: string;
    sessionId: string;
    question: string;
    reason: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<CameraFrame> {
    if (options.signal.aborted) {
      throw new Error("摄像头抓帧已取消");
    }
    const client = this.clients.values().next().value;
    if (!client) throw new Error("用户尚未开启摄像头，或摄像头窗口未连接");
    const captureId = crypto.randomUUID().replaceAll("-", "");
    const sent = client.sendCaptureRequest({
      captureId,
      question: options.question,
      reason: options.reason,
      timeoutS: options.timeoutMs / 1000,
    });
    if (!sent) throw new Error("摄像头窗口没有响应");

    return new Promise<CameraFrame>((resolve, reject) => {
      if (options.signal.aborted) {
        reject(new Error("摄像头抓帧已取消"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(captureId);
        reject(new Error("等待摄像头画面超时"));
      }, options.timeoutMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.pending.delete(captureId);
        reject(new Error("摄像头抓帧已取消"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(captureId, {
        client,
        resolve: (frame) => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", onAbort);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
    });
  }

  resolve(
    client: CameraClient,
    captureId: string,
    result: { ok: boolean; image?: Buffer; mimeType?: string; error?: string },
  ): boolean {
    const pending = this.pending.get(captureId);
    if (!pending || pending.client.id !== client.id) return false;
    this.pending.delete(captureId);
    if (!result.ok || !result.image) {
      pending.reject(new Error(result.error || "摄像头没有返回画面"));
      return true;
    }
    pending.resolve({
      image: result.image,
      mimeType: result.mimeType || "image/jpeg",
    });
    return true;
  }
}
