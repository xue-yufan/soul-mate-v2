export const RUN_DISCONNECT_GRACE_MS = 30_000;
export const RUN_RETENTION_MS = 120_000;
const MAX_RECORDED_EVENTS = 4_096;

export interface RecordedRunEvent {
  type: string;
  data: Record<string, unknown>;
  seq: number;
  ts: string;
}

export interface RunResumeResult {
  sessionId: string;
  active: boolean;
  events: RecordedRunEvent[];
}

interface RunState {
  requestId: string;
  sessionId: string;
  clientId: string;
  controller: AbortController;
  events: RecordedRunEvent[];
  nextSeq: number;
  active: boolean;
  replayable: boolean;
  disconnectedTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
}

export class ResumableRunRegistry {
  private readonly runs = new Map<string, RunState>();

  start(options: {
    requestId: string;
    sessionId: string;
    clientId: string;
    controller: AbortController;
  }): boolean {
    if (this.runs.has(options.requestId)) return false;
    this.runs.set(options.requestId, {
      ...options,
      events: [],
      nextSeq: 1,
      active: true,
      replayable: true,
      disconnectedTimer: null,
      cleanupTimer: null,
    });
    return true;
  }

  hasActiveClient(clientId: string): boolean {
    return [...this.runs.values()].some(
      (run) => run.active && run.clientId === clientId,
    );
  }

  record(
    requestId: string,
    type: string,
    data: Record<string, unknown>,
  ): RecordedRunEvent | null {
    const run = this.runs.get(requestId);
    if (!run || !run.active || !run.replayable) return null;
    if (run.events.length >= MAX_RECORDED_EVENTS) {
      run.replayable = false;
      return null;
    }
    const event = {
      type,
      data,
      seq: run.nextSeq,
      ts: new Date().toISOString(),
    };
    run.nextSeq += 1;
    run.events.push(event);
    return event;
  }

  resume(
    requestId: string,
    clientId: string,
    afterSeq: number,
  ): RunResumeResult | null {
    const run = this.runs.get(requestId);
    if (!run || run.clientId !== clientId || !run.replayable) return null;
    this.clearDisconnectedTimer(run);
    return {
      sessionId: run.sessionId,
      active: run.active,
      events: run.events.filter((event) => event.seq > afterSeq),
    };
  }

  finish(requestId: string): void {
    const run = this.runs.get(requestId);
    if (!run || !run.active) return;
    run.active = false;
    this.clearDisconnectedTimer(run);
    this.scheduleCleanup(run);
  }

  markClientDisconnected(clientId: string): void {
    for (const run of this.runs.values()) {
      if (!run.active || run.clientId !== clientId) continue;
      this.clearDisconnectedTimer(run);
      run.disconnectedTimer = setTimeout(() => {
        this.expireDisconnected(run);
      }, RUN_DISCONNECT_GRACE_MS);
      run.disconnectedTimer.unref();
    }
  }

  close(): void {
    for (const run of this.runs.values()) {
      this.clearDisconnectedTimer(run);
      this.clearCleanupTimer(run);
      if (run.active) {
        run.controller.abort(new Error("后端正在关闭"));
      }
    }
    this.runs.clear();
  }

  get size(): number {
    return this.runs.size;
  }

  private expireDisconnected(run: RunState): void {
    run.disconnectedTimer = null;
    if (!run.active) return;
    if (run.replayable && run.events.length < MAX_RECORDED_EVENTS) {
      run.events.push({
        type: "error",
        data: {
          code: "connection_lost",
          message: "连接中断超过恢复时限，本轮已终止",
        },
        seq: run.nextSeq,
        ts: new Date().toISOString(),
      });
      run.nextSeq += 1;
    } else {
      run.replayable = false;
    }
    run.active = false;
    run.controller.abort(new Error("连接中断超过恢复时限"));
    this.scheduleCleanup(run);
  }

  private scheduleCleanup(run: RunState): void {
    this.clearCleanupTimer(run);
    run.cleanupTimer = setTimeout(() => {
      if (this.runs.get(run.requestId) === run) {
        this.runs.delete(run.requestId);
      }
    }, RUN_RETENTION_MS);
    run.cleanupTimer.unref();
  }

  private clearDisconnectedTimer(run: RunState): void {
    if (run.disconnectedTimer === null) return;
    clearTimeout(run.disconnectedTimer);
    run.disconnectedTimer = null;
  }

  private clearCleanupTimer(run: RunState): void {
    if (run.cleanupTimer === null) return;
    clearTimeout(run.cleanupTimer);
    run.cleanupTimer = null;
  }
}
