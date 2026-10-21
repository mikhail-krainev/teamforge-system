import { describe, expect, it } from 'vitest';
import { evaluateAccount } from './account-rules.js';
import { ciStateOf } from './ci-rules.js';
import { evaluateRepoFinal } from './repo-final-rules.js';
import { crossReviewedPullCount } from './review-rules.js';

const NOW = new Date('2026-10-18T00:00:00Z');
const DAY = 86_400_000;

describe('repo_final (FR-GH-08)', () => {
  const good = { rejections: [], commits: 10, committingMembers: 2 } as const;

  it('passes at exactly 10 commits and 2 committing members', () => {
    expect(evaluateRepoFinal(good)).toEqual({ ok: true, reasons: [] });
  });

  it('names every failing rule', () => {
    expect(
      evaluateRepoFinal({ rejections: ['REPO_ARCHIVED'], commits: 9, committingMembers: 1 }),
    ).toEqual({
      ok: false,
      reasons: ['REPO_ARCHIVED', 'REPO_TOO_FEW_COMMITS', 'REPO_TOO_FEW_COMMITTERS'],
    });
  });

  it('a repository the installation cannot see says nothing else', () => {
    expect(
      evaluateRepoFinal({
        rejections: ['REPO_NOT_IN_INSTALLATION'],
        commits: 0,
        committingMembers: 0,
      }),
    ).toEqual({ ok: false, reasons: ['REPO_NOT_IN_INSTALLATION'] });
  });
});

describe('account age (FR-GH-09)', () => {
  const account = (days: number, repos: number, activity: boolean) =>
    evaluateAccount(
      {
        accountCreatedAt: new Date(NOW.getTime() - days * DAY),
        publicRepos: repos,
        hasPublicActivity: activity,
      },
      NOW,
    );

  it('30 days old with a public repository is eligible', () => {
    expect(account(30, 1, false)).toEqual({ eligible: true, reasons: [] });
  });

  it('29 days old is too young', () => {
    expect(account(29, 5, true).reasons).toEqual(['ACCOUNT_TOO_YOUNG']);
  });

  it('public activity replaces a public repository; neither fails', () => {
    expect(account(100, 0, true).eligible).toBe(true);
    expect(account(100, 0, false).reasons).toEqual(['ACCOUNT_NO_PUBLIC_ACTIVITY']);
  });
});

describe('ci_workflow', () => {
  it('needs a successful run on the default branch', () => {
    expect(ciStateOf([{ conclusion: 'success', head_branch: 'main' }], 'main')).toBe('success');
    expect(ciStateOf([{ conclusion: 'success', head_branch: 'feature' }], 'main')).toBe('none');
    expect(ciStateOf([{ conclusion: 'failure', head_branch: 'main' }], 'main')).toBe('none');
    expect(ciStateOf([], 'main')).toBe('none');
  });

  it('no permission to read the runs is "not checked"', () => {
    expect(ciStateOf(null, 'main')).toBeNull();
  });
});

describe('pr_cross_review', () => {
  const pulls = [
    { number: 1, authorGithubId: 10 },
    { number: 2, authorGithubId: 10 },
    { number: 3, authorGithubId: 11 },
  ];

  it('counts pull requests reviewed by somebody else', () => {
    const reviews = [
      { prNumber: 1, reviewerGithubId: 11, state: 'approved' },
      { prNumber: 2, reviewerGithubId: 10, state: 'approved' },
      { prNumber: 3, reviewerGithubId: 10, state: 'dismissed' },
    ];
    expect(crossReviewedPullCount(pulls, reviews)).toBe(1);
  });
});
