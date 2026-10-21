/** Why a repository cannot be bound (FR-GH-02, FR-GH-08); the codes are the contract of `errors[].code`. */
export type RepoRejectionCode =
  | 'REPO_NOT_IN_INSTALLATION'
  | 'REPO_ARCHIVED'
  | 'REPO_NOT_PUBLIC'
  | 'REPO_FORK';

/** What GitHub says about a repository, reduced to what the rules need. */
export interface RepoFacts {
  archived: boolean;
  isPrivate: boolean;
  isFork: boolean;
}

const MESSAGES: Record<RepoRejectionCode, string> = {
  REPO_NOT_IN_INSTALLATION: 'The repository is not on this installation of the GitHub App',
  REPO_ARCHIVED: 'The repository is archived',
  REPO_NOT_PUBLIC: 'The repository is not public',
  REPO_FORK: 'The fork has no commits of its own',
};

export const rejectionMessage = (code: RepoRejectionCode): string => MESSAGES[code];

/**
 * Every reason the repository is refused, in a stable order. `null` facts mean the installation cannot
 * see the repository: nothing else is revealed about it. A fork is accepted only with commits of its own.
 */
export function rejectionsOf(
  facts: RepoFacts | null,
  forkHasOwnCommits: boolean,
): RepoRejectionCode[] {
  if (facts === null) return ['REPO_NOT_IN_INSTALLATION'];
  const reasons: RepoRejectionCode[] = [];
  if (facts.archived) reasons.push('REPO_ARCHIVED');
  if (facts.isPrivate) reasons.push('REPO_NOT_PUBLIC');
  if (facts.isFork && !forkHasOwnCommits) reasons.push('REPO_FORK');
  return reasons;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** AF-03 (FR-GH-02): a repository created more than 30 days before the start of the project. */
export function isOlderThanThirtyDays(repoCreatedAt: Date, projectStart: Date): boolean {
  return projectStart.getTime() - repoCreatedAt.getTime() > THIRTY_DAYS_MS;
}
