export interface RealtimeClient {
  readonly id: string;
  send(type: string, data?: Record<string, unknown>): void;
  sendRaw(event: Record<string, unknown>): boolean;
}

export class RealtimeHub {
  private readonly clients = new Map<string, RealtimeClient>();

  register(client: RealtimeClient): void {
    this.clients.set(client.id, client);
  }

  replace(previousId: string, client: RealtimeClient): void {
    if (this.clients.get(previousId) === client) {
      this.clients.delete(previousId);
    }
    this.register(client);
  }

  unregister(client: RealtimeClient): void {
    if (this.clients.get(client.id) === client) {
      this.clients.delete(client.id);
    }
  }

  current(clientId: string): RealtimeClient | undefined {
    return this.clients.get(clientId);
  }

  notifyShutdown(message: string): number {
    for (const client of this.clients.values()) {
      client.send("server_shutdown", { message });
    }
    return this.clients.size;
  }

  get size(): number {
    return this.clients.size;
  }
}
