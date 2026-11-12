import type { HistoryPort } from "@soul-mate/agent-contracts";
import type { Database } from "./database.js";

export class SqliteHistoryPort implements HistoryPort {
  constructor(private readonly db: Database) {}

  async loadRecent(
    sessionId: string,
    options: { maxTurns: number; excludeMessageId?: string },
  ) {
    return this.db.loadRecentMessages(
      sessionId,
      options.maxTurns,
      options.excludeMessageId,
    );
  }

  async loadSummary(sessionId: string): Promise<string | null> {
    return this.db.loadSummary(sessionId);
  }
}
