import crypto from "node:crypto";

interface PendingConfirm {
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
  ownerId?: string;
}

export class PendingRegistry {
  private readonly entries = new Map<string, PendingConfirm>();

  async wait(timeoutMs: number): Promise<string> {
    const confirmId = crypto.randomUUID().replaceAll("-", "");
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.entries.delete(confirmId);
        resolve(false);
      }, timeoutMs);
      this.entries.set(confirmId, { resolve, timer });
    });
    return allowed ? confirmId : `${confirmId}:timeout`;
  }

  createId(): string {
    return crypto.randomUUID().replaceAll("-", "");
  }

  waitFor(
    confirmId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    ownerId?: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout;
      let onAbort: () => void;
      const finish = (allowed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.entries.delete(confirmId);
        resolve(allowed);
      };
      timer = setTimeout(() => {
        finish(false);
      }, timeoutMs);
      onAbort = (): void => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.entries.set(confirmId, {
        resolve: finish,
        timer,
        ...(ownerId ? { ownerId } : {}),
      });
    });
  }

  resolve(
    confirmId: string,
    allowed: boolean,
    ownerId?: string,
  ): boolean {
    const pending = this.entries.get(confirmId);
    if (!pending) return false;
    if (pending.ownerId && ownerId && pending.ownerId !== ownerId) return false;
    pending.resolve(allowed);
    return true;
  }

  hasOwner(ownerId: string): boolean {
    return [...this.entries.values()].some(
      (pending) => pending.ownerId === ownerId,
    );
  }

  resolveForOwner(ownerId: string, allowed: boolean): boolean {
    const pending = [...this.entries.entries()]
      .reverse()
      .find(([, entry]) => entry.ownerId === ownerId);
    if (!pending) return false;
    pending[1].resolve(allowed);
    return true;
  }

  clear(): void {
    for (const pending of [...this.entries.values()]) {
      pending.resolve(false);
    }
    this.entries.clear();
  }
}
