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
    /**
     * `dirty` is set when an outbox event was written in the active transaction attempt (kick the relay after
     * commit). An object made per attempt outside the transaction's own CLS store, like `afterCommit`.
     */
    outboxKick?: { dirty: boolean };
    /**
     * Users whose lock #1 the active transaction attempt holds, with what `lockUserForJoin` read
     * under it (architecture 3.4, `TeamsApi.joinSeat` with `userLocked: true`).
     */
    lockedUsers?: Record<string, { githubUserId: number | null; consentValid: boolean }>;
    /** Work queued by `TxRunner.afterCommit` in the active transaction attempt (runs after the commit). */
    afterCommit?: (() => Promise<void>)[];
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
