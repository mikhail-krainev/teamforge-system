/**
 * Public surface of the workspace module (ADR-0001): the only file other modules may import.
 * S6-08: the completion of a project. The block rules of the anti-fraud list (AF-01, AF-02, AF-04, AF-09,
 * AF-10) are the pure conditions of `completion-rules.ts`; slice 7 reads them as signals from here.
 */
export const WORKSPACE_MODULE = 'workspace' as const;

export type { CompletionSnapshot } from './internal/domain/completion-snapshot.js';
export {
  completionUnmet,
  contributionDaysTooFew,
  contributionTooLow,
  contributorsTooFew,
  durationTooShort,
  fraudBlock,
  isReleaseAddressRepeated,
  isTemplateAddress,
  membersBelowMin,
  stageClosedTooFast,
  type CompletionFacts,
  type ContributionFact,
  type StageFact,
  type UnmetCode,
} from './internal/domain/completion-rules.js';

import type { CompletionSnapshot } from './internal/domain/completion-snapshot.js';

/** What the other modules ask of the completed project (architecture 3.6). */
export interface WorkspaceApi {
  /** `null` while the project is not completed. */
  getCompletion(
    teamId: string,
  ): Promise<{ completedAt: Date; plannedEndAt: Date; overdueDays: number } | null>;
  /** The immutable record of the completion; 404 NOT_FOUND while the project is not completed. */
  getCompletionSnapshot(teamId: string): Promise<CompletionSnapshot>;
}

export const WORKSPACE_API = Symbol('WORKSPACE_API');
