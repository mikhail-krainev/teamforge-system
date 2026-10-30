import type { CompletionFacts } from '../../../../workspace/public.js';
import type { FraudFacts } from './facts.js';

/**
 * The facts of the completion conditions of the workspace module (`completion-rules.ts`) seen from the anti-fraud
 * facts: the block rules AF-02, AF-04, AF-09 and AF-10 call those pure conditions instead of copying them.
 * The fields about the completion check do not take part in them.
 */
export function toCompletionFacts(facts: FraudFacts): CompletionFacts {
  return {
    now: facts.now,
    stages: facts.stages.map((s) => ({
      ordinal: s.ordinal,
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
    })),
    memberCount: facts.members.length,
    contributions: facts.contributions.map((c) => ({
      userId: c.userId,
      source: c.source,
      ref: c.ref,
      active: c.active,
      receivedAt: c.receivedAt,
    })),
    check: null,
    releaseUrl: facts.release.url,
    repositoryId: facts.repository.id,
    releaseAddressHeld: facts.release.heldByCreditedProject,
  };
}
