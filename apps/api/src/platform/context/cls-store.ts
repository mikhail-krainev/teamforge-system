import type { ClsService } from 'nestjs-cls';
import { InvariantError } from '../errors/domain-error.js';

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
    /** Creation time (epoch ms) of the session behind `userId`, when the authenticator knows it. */
    sessionCreatedAt?: number;
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

/** The signed-in user of the request, set by AuthzGuard; operations that need a session call this. */
export function requireUserId(cls: ClsService): string {
  const id = cls.get('userId');
  if (id === undefined) throw new InvariantError('Operation without a signed-in user');
  return id;
}
