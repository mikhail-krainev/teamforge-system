import type { FraudFacts, Signal } from './facts.js';
import { block } from './signal.js';

export const RULE_CODE = 'AF-01';

/**
 * AF-01: the repository (by `repository_id`) belongs to one credited project only, and a fork of a foreign
 * repository needs own commits. A block: the project cannot be completed at all (FR-GH-02, FR-GH-08).
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const { boundToCreditedProject, forkWithoutOwnCommits } = facts.repository;
  if (!boundToCreditedProject && !forkWithoutOwnCommits) return [];
  return [
    block(RULE_CODE, {
      repositoryId: facts.repository.id,
      boundToCreditedProject,
      forkWithoutOwnCommits,
    }),
  ];
}
