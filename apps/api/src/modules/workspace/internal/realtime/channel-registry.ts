/** One authenticated WebSocket of this process. */
export interface RealtimeConnection {
  readonly userId: string;
  readonly channels: Set<string>;
  send(text: string): void;
  close(code: number): void;
  ping(): void;
}

/**
 * Which local sockets listen to which channel (architecture 9). In memory and ephemeral on
 * purpose: a restart drops the sockets, and the client subscribes again when it reconnects.
 */
export class ChannelRegistry {
  private readonly byChannel = new Map<string, Set<RealtimeConnection>>();
  private readonly byUser = new Map<string, Set<RealtimeConnection>>();

  add(connection: RealtimeConnection): void {
    const set = this.byUser.get(connection.userId) ?? new Set<RealtimeConnection>();
    set.add(connection);
    this.byUser.set(connection.userId, set);
    this.subscribe(connection, `user:${connection.userId}`);
  }

  remove(connection: RealtimeConnection): void {
    for (const channel of [...connection.channels]) this.unsubscribe(connection, channel);
    const set = this.byUser.get(connection.userId);
    set?.delete(connection);
    if (set?.size === 0) this.byUser.delete(connection.userId);
  }

  subscribe(connection: RealtimeConnection, channel: string): void {
    connection.channels.add(channel);
    const set = this.byChannel.get(channel) ?? new Set<RealtimeConnection>();
    set.add(connection);
    this.byChannel.set(channel, set);
  }

  unsubscribe(connection: RealtimeConnection, channel: string): void {
    connection.channels.delete(channel);
    const set = this.byChannel.get(channel);
    set?.delete(connection);
    if (set?.size === 0) this.byChannel.delete(channel);
  }

  connectionsOf(userId: string): RealtimeConnection[] {
    return [...(this.byUser.get(userId) ?? [])];
  }

  /** Sends `text` to every local listener of `channel`. */
  deliver(channel: string, text: string): void {
    for (const connection of this.byChannel.get(channel) ?? []) connection.send(text);
  }

  /** Drops one user from a team channel (left, excluded); returns how many sockets were affected. */
  revoke(channel: string, userId: string): number {
    const affected = this.connectionsOf(userId).filter((c) => c.channels.has(channel));
    for (const connection of affected) this.unsubscribe(connection, channel);
    return affected.length;
  }

  all(): RealtimeConnection[] {
    return [...this.byUser.values()].flatMap((set) => [...set]);
  }
}
