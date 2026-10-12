import type { ClsService } from 'nestjs-cls';
import { lockTimeoutError } from '../errors/domain-error.js';

/** State of one transaction attempt, shared through CLS (see TxRunner). */
export interface AttemptState {
  /** Set when the application deadline of the attempt passed: the attempt must roll back. */
  aborted: boolean;
  /** Set after the last check, right before COMMIT: from now on the deadline no longer applies. */
  finishing: boolean;
}

/**
 * Throws once the attempt deadline passed. Called by TxRunner before the commit hooks and by the
 * platform helpers that run statements (locks, outbox), so an attempt whose client already got
 * 503 can never commit: its statements fail and the transaction rolls back (S1R-05).
 */
export function assertAttemptAlive(cls: ClsService): void {
  if (cls.isActive() && cls.get('attempt')?.aborted === true) throw lockTimeoutError();
}
