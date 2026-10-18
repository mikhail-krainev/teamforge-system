import type { RepoRejectionCode } from '../services/repo-rules.js';

/** C-58 (FR-GH-08): commits the repository must have when the project is completed. */
export const MIN_FINAL_COMMITS = 10;
/** FR-GH-08: members with a linked GitHub account who must have committed. */
export const MIN_COMMITTING_MEMBERS = 2;

export type RepoFinalReason = RepoRejectionCode | 'REPO_TOO_FEW_COMMITS' | 'REPO_TOO_FEW_COMMITTERS';

export interface RepoFinalFacts {
  /** The binding rules that fail now: gone, archived, private, fork without own commits. */
  rejections: readonly RepoRejectionCode[];
  /** Commits of all contributors of the repository. */
  commits: number;
  /** Distinct members of the team whose linked GitHub account committed. */
  committingMembers: number;
}

export interface RepoFinalVerdict {
  ok: boolean;
  reasons: RepoFinalReason[];
}

/**
 * `repo_final` (FR-GH-08, AF-01): the repository exists, is not archived, is public, is not a fork
 * without changes of its own, has at least 10 commits, and at least two members of the team committed.
 * A repository the installation cannot see has nothing more to say about: its other facts are unknown.
 */
export function evaluateRepoFinal(facts: RepoFinalFacts): RepoFinalVerdict {
  if (facts.rejections.includes('REPO_NOT_IN_INSTALLATION')) {
    return { ok: false, reasons: ['REPO_NOT_IN_INSTALLATION'] };
  }
  const reasons: RepoFinalReason[] = [...facts.rejections];
  if (facts.commits < MIN_FINAL_COMMITS) reasons.push('REPO_TOO_FEW_COMMITS');
  if (facts.committingMembers < MIN_COMMITTING_MEMBERS) reasons.push('REPO_TOO_FEW_COMMITTERS');
  return { ok: reasons.length === 0, reasons };
}
