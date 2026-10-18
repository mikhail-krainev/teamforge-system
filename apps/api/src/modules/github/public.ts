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
  /** @requiresTx Called in the completion transaction (T6, AF-01): the repository stays taken for good. */
  markRepositoryCompleted(teamId: TeamId): Promise<void>;
}

export const GITHUB_API = Symbol('GITHUB_API');
