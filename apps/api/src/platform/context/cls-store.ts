import 'nestjs-cls';

/** Idempotency state of the current request, set by IdempotencyInterceptor. */
export interface IdempotencyContext {
  userId: string;
  key: string;
  lockToken: string;
  /** Status the handler will answer with on success (decorator value or the method default). */
  successStatus: number;
  /** True once the key row was completed inside a business transaction. */
  completedInTx: boolean;
  /** True once the transaction that completed the key has committed (set by TxRunner). */
  committed: boolean;
}

declare module 'nestjs-cls' {
  interface ClsStore {
    requestId?: string;
    userId?: string;
    operationId?: string;
    idempotency?: IdempotencyContext;
    /** Highest lock level taken in the active transaction attempt (architecture 12.1). */
    lockLevel?: number;
    /** Set when an outbox event was written in the active transaction (kick the relay after commit). */
    outboxDirty?: boolean;
    /** Deadline state of the active transaction attempt (architecture 12.1). */
    attempt?: import('../tx/attempt.js').AttemptState;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Filled by OperationContextInterceptor for the request log line. */
    tf?: { operationId?: string; userId?: string };
  }
}
