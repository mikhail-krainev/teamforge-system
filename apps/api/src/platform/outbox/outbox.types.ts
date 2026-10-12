/** Event as stored in platform.outbox_event and delivered to consumers. Payload: ids only. */
export interface OutboxEventData {
  id: string;
  module: string;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  requestId: string | null;
}

export interface NewOutboxEvent {
  module: string;
  type: string;
  aggregateId: string;
  /** Identifiers and numeric flags only; personal data in events is forbidden (architecture 4). */
  payload: Record<string, unknown>;
}

/** Subscription of a module handler to outbox events. */
export interface EventConsumer {
  /** Unique consumer name; part of the BullMQ jobId and of the inbox primary key. */
  readonly consumer: string;
  /** Event types, `module.type` or `*` for all. */
  readonly types: readonly string[];
  /** Runs inside a transaction together with the inbox insert; must be "re-read and reconcile". */
  handle(event: OutboxEventData): Promise<void>;
}

export const OUTBOX_KICK_CHANNEL = 'outbox:kick';
export const OUTBOX_BATCH = 200;
export const OUTBOX_POLL_MS = 250;
