import { Injectable } from '@nestjs/common';
import type { DeficitPort, TeamLifecyclePort } from '../../public.js';

/**
 * Default binding of `DeficitPort` until matching implements it (slice 4): no deficit, empty queue.
 * A joining person is therefore never marked as filling a deficit (FR-MATCH-11 starts in slice 4).
 */
@Injectable()
export class StubDeficitPort implements DeficitPort {
  evaluate(input: Parameters<DeficitPort['evaluate']>[0]): ReturnType<DeficitPort['evaluate']> {
    return Promise.resolve({ deficit: false, openSeats: input.openSeats, queued: 0 });
  }
}

/** Default binding of `TeamLifecyclePort` until workspace implements it (slice 5): does nothing. */
@Injectable()
export class StubTeamLifecyclePort implements TeamLifecyclePort {
  onProjectStarted(): Promise<void> {
    return Promise.resolve();
  }
}
