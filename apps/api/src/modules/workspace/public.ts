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
  isTemplateAddress,
  membersBelowMin,
  stageClosedTooFast,
  type CompletionFacts,
  type ContributionFact,
  type StageFact,
  type UnmetCode,
} from './internal/domain/completion-rules.js';

import type { CompletionSnapshot } from './internal/domain/completion-snapshot.js';

/** What the anti-fraud rules of rewards read besides the snapshot (S7-03, architecture 3.6). */
export interface AntifraudFacts {
  /** Planned length and real times of every stage of the route. */
  stages: { ordinal: number; plannedDays: number; openedAt: Date | null; closedAt: Date | null }[];
  /** The files of the project that still exist; `sameHashInOtherTeam` is AF-06. */
  artifacts: { name: string; sizeBytes: number; sha256: string; sameHashInOtherTeam: boolean }[];
  /** The newest look at the release address found a stub page (AF-02). */
  releasePlaceholder: boolean;
}

/** What the other modules ask of the completed project (architecture 3.6). */
export interface WorkspaceApi {
  /** `null` while the project is not completed. */
  getCompletion(
    teamId: string,
  ): Promise<{ completedAt: Date; plannedEndAt: Date; overdueDays: number } | null>;
  /** The immutable record of the completion; 404 NOT_FOUND while the project is not completed. */
  getCompletionSnapshot(teamId: string): Promise<CompletionSnapshot>;
  /** The facts of the anti-fraud rules (AF-02, AF-06, AF-09..AF-12): stored state, read before the credit transaction. */
  getAntifraudFacts(teamId: string): Promise<AntifraudFacts>;
  /** Teams other than `exceptTeamId` that hold a file with one of the SHA-256 hashes (hex). */
  findTeamsWithArtifactHashes(hashes: string[], exceptTeamId: string): Promise<string[]>;
  /**
   * Safety net for lost events (`credit-run-scan`, `review-eligibility-scan`): completions dated `since` or
   * later, oldest first, keyset by `(completedAt, teamId)`; `after` is the last row of the previous page.
   */
  listCompletedTeamsSince(
    since: Date,
    page: { limit: number; after?: { completedAt: Date; teamId: string } },
  ): Promise<{ teamId: string; completedAt: Date }[]>;
}

export const WORKSPACE_API = Symbol('WORKSPACE_API');
