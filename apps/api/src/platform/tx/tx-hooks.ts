import { Injectable } from '@nestjs/common';

export interface TxListener {
  /** Runs as the LAST statements of every business transaction attempt (inside it). */
  beforeCommit?(result: unknown): Promise<void>;
  /** Runs after a successful commit of the outermost transaction. */
  afterCommit?(): Promise<void>;
}

/** Lets platform services (idempotency, outbox) take part in TxRunner without circular imports. */
@Injectable()
export class TxHooks {
  private readonly listeners: TxListener[] = [];

  register(listener: TxListener): void {
    this.listeners.push(listener);
  }

  async beforeCommit(result: unknown): Promise<void> {
    for (const listener of this.listeners) await listener.beforeCommit?.(result);
  }

  async afterCommit(): Promise<void> {
    for (const listener of this.listeners) await listener.afterCommit?.();
  }
}
