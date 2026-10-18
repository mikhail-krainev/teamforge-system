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

export interface GithubApi {
  /** The repository that holds the team now (active or of a completed project), or `null`. */
  getRepoLink(teamId: TeamId): Promise<RepoLinkView | null>;
  /**
   * `repo_exists` for the repository of the team: asks GitHub with the installation token and keeps
   * the result in `repo_check` (kind `exists`). A GitHub failure rejects; nothing is recorded.
   */
  checkRepositoryExists(teamId: TeamId): Promise<RepoExistsResult>;
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
