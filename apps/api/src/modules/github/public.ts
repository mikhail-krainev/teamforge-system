/**
 * Public surface of the github module (ADR-0001): the only file other modules may import.
 * Contract: architecture 3.7.
 */
export const GITHUB_MODULE = 'github' as const;

export type TeamId = string;

export interface RepoLinkView {
  teamId: TeamId;
  repositoryId: number;
  installationId: number;
  fullName: string;
  status: 'active' | 'completed' | 'unlinked';
  isPrivate: boolean;
  repoCreatedAt: Date;
}

/** The answer of the `repo_exists` check (FR-PLAY-08): the repository exists, is not archived and is public. */
export interface RepoExistsResult {
  ok: boolean;
  /** Empty when `ok`; `NO_REPOSITORY` when the team has none, else the codes `REPO_*` of the binding rules. */
  reasons: string[];
  checkedAt: Date;
}

/** The answer of `repo_final` (FR-GH-08): `reasons` are `REPO_*` codes, `NO_REPOSITORY`, `REPO_TOO_FEW_COMMITS`, `REPO_TOO_FEW_COMMITTERS`. */
export interface RepoFinalResult {
  ok: boolean;
  reasons: string[];
  /** Commits of all contributors of the repository. */
  commits: number;
  /** Distinct members of the team whose linked GitHub account committed. */
  committingMembers: number;
  checkedAt: Date;
}

/** FR-GH-09: `pending_account` means the credit waits, it is not refused; `unknown` until the account was checked. */
export interface AccountEligibility {
  status: 'eligible' | 'pending_account' | 'unknown';
  /** `ACCOUNT_TOO_YOUNG`, `ACCOUNT_NO_PUBLIC_ACTIVITY`. */
  reasons: string[];
}

/** FR-GH-09 and AF-16 for one account; `ageDays` and `hasPublicActivity` are `null` until the account was checked. */
export interface AccountCheckView {
  eligibility: AccountEligibility;
  ageDays: number | null;
  hasPublicActivity: boolean | null;
}

/** AF-05: the changed lines (additions + deletions) of the merged pull requests and the share of the biggest one. */
export interface PullRequestStats {
  changedLines: number;
  maxPrShare: number;
}

/** AF-01, AF-03: the repository of the project as stored. */
export interface RepositoryFacts {
  repositoryId: number;
  createdAt: Date;
  /** Another completed project holds the same repository. */
  heldByOtherProject: boolean;
  /** The last `repo_final` check found a fork without commits of its own. */
  forkWithoutOwnCommits: boolean;
}

export interface GithubApi {
  /** The repository that holds the team now (active or of a completed project), or `null`. */
  getRepoLink(teamId: TeamId): Promise<RepoLinkView | null>;
  /**
   * `repo_exists` for the repository of the team: asks GitHub with the installation token and keeps
   * the result in `repo_check` (kind `exists`). A GitHub failure rejects; nothing is recorded.
   */
  checkRepositoryExists(teamId: TeamId): Promise<RepoExistsResult>;
  /**
   * `repo_final` of the repository that holds the team (FR-GH-08): the binding rules, at least 10 commits,
   * commits of at least two members with a linked account. Keeps the result in `repo_check` (kind `final`).
   * A GitHub failure rejects; nothing is recorded.
   */
  checkRepositoryFinal(teamId: TeamId): Promise<RepoFinalResult>;
  /** `pr_cross_review:N`: merged pull requests of the team's repository with a review by somebody but the author. */
  getCrossReviewedPullCount(teamId: TeamId): Promise<number>;
  /** `ci_workflow`: a successful run on the default branch (`success`), none (`none`), or `null` when not checked. */
  getCiState(teamId: TeamId): Promise<'success' | 'none' | null>;
  /** FR-GH-09 for the credit (FR-REW-01 item 5), from the daily account check. */
  getAccountEligibility(userId: string): Promise<AccountEligibility>;
  /** FR-GH-09 for several accounts at once (rewards reads it before its transaction): stored checks only. */
  getAccountChecks(userIds: string[]): Promise<Map<string, AccountCheckView>>;
  /** AF-05 from the stored pull requests of the team's repository. */
  getPullRequestStats(teamId: TeamId): Promise<PullRequestStats>;
  /** AF-01, AF-03: `null` when the team has no repository. */
  getRepositoryFacts(teamId: TeamId): Promise<RepositoryFacts | null>;
  /**
   * Whether the issue is closed or the pull request merged now, as the last event or the sync left it;
   * `null` for an item that is not known. Handlers of contribution events reconcile against it:
   * deliveries of events are not ordered (architecture 4).
   */
  isContributionSourceStanding(
    source: GithubContributionSource,
    repositoryId: number,
    number: number,
  ): Promise<boolean | null>;
  /** @requiresTx Called in the completion transaction (T6, AF-01): the repository stays taken for good. */
  markRepositoryCompleted(teamId: TeamId): Promise<void>;
}

export const GITHUB_API = Symbol('GITHUB_API');

/** The source of a contribution that GitHub gives (`github.contribution_detected`, architecture 3.7). */
export type GithubContributionSource = 'issue' | 'pr';

/** `ref` of a contribution of GitHub: `issue:<repositoryId>#<number>` or `pr:<repositoryId>#<number>`. */
export function contributionRef(
  source: GithubContributionSource,
  repositoryId: number,
  number: number,
): string {
  return `${source}:${repositoryId}#${number}`;
}

/** The parts of a `ref` made by `contributionRef`, or `null` for any other text. */
export function parseContributionRef(
  ref: string,
): { source: GithubContributionSource; repositoryId: number; number: number } | null {
  const match = /^(issue|pr):(\d+)#(\d+)$/.exec(ref);
  if (match === null) return null;
  return {
    source: match[1] as GithubContributionSource,
    repositoryId: Number(match[2]),
    number: Number(match[3]),
  };
}

/**
 * Payload of `github.contribution_detected` (version 1). The people are listed as users of the
 * platform who are members of the team; the work itself is named by `ref`.
 */
export interface ContributionDetectedPayload {
  v: 1;
  teamId: TeamId;
  repositoryId: number;
  source: GithubContributionSource;
  ref: string;
  number: number;
  title: string;
  url: string;
  userIds: string[];
  labels: string[];
  /** When it happened on GitHub (informational: the server time `receivedAt` is what counts, AF-23). */
  occurredAt: string;
  receivedAt: string;
}

/** Payload of `github.contribution_revoked` (an issue was reopened). */
export interface ContributionRevokedPayload {
  v: 1;
  teamId: TeamId;
  repositoryId: number;
  source: GithubContributionSource;
  ref: string;
}
