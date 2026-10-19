import { describe, expect, it } from 'vitest';
import {
  type CompletionFacts,
  completionUnmet,
  isTemplateAddress,
  overdueDaysOf,
} from './completion-rules.js';

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-03-31T12:00:00Z');
const at = (days: number): Date => new Date(NOW.getTime() - days * DAY);

const RELEASE = 'https://app.release.test/';

function facts(change: Partial<CompletionFacts> = {}): CompletionFacts {
  const contributions = Array.from({ length: 10 }, (_, i) => ({
    userId: i % 2 === 0 ? 'u1' : 'u2',
    source: i % 3 === 0 ? 'pr' : 'issue',
    ref: `${i % 3 === 0 ? 'pr' : 'issue'}:7#${i + 1}`,
    active: true,
    receivedAt: at(20 - (i % 3)),
  }));
  return {
    now: NOW,
    stages: [1, 2, 3].map((ordinal) => ({
      ordinal,
      status: 'closed',
      openedAt: at(30 - ordinal * 5),
      closedAt: at(25 - ordinal * 5),
    })),
    memberCount: 3,
    contributions,
    check: {
      validUntil: new Date(NOW.getTime() + 600_000),
      results: [
        { key: 'repo_final', ok: true, blocking: true, message: 'ok', data: { repositoryId: 7 } },
        {
          key: 'release_alive_web',
          ok: true,
          blocking: true,
          message: 'ok',
          data: { url: RELEASE },
        },
        { key: 'link_https:board', ok: true, blocking: true, message: 'ok' },
      ],
    },
    releaseUrl: RELEASE,
    repositoryId: 7,
    releaseAddressHeld: false,
    ...change,
  };
}

const codes = (f: CompletionFacts): string[] => completionUnmet(f).map((u) => u.code);

describe('completionUnmet (FR-WORK-13, architecture 11.4)', () => {
  it('a project that meets everything has nothing unmet', () => {
    expect(codes(facts())).toEqual([]);
  });

  it('a stage that is not closed, or no stages at all: STAGES_NOT_CLOSED', () => {
    const open = facts().stages.map((s, i) => (i === 2 ? { ...s, status: 'open' } : s));
    expect(codes(facts({ stages: open }))).toContain('STAGES_NOT_CLOSED');
    expect(codes(facts({ stages: [] }))).toContain('STAGES_NOT_CLOSED');
  });

  it('no check: only COMPLETION_CHECK_MISSING from the check; an old one: COMPLETION_CHECK_EXPIRED', () => {
    expect(codes(facts({ check: null }))).toEqual(['COMPLETION_CHECK_MISSING']);
    const old = { validUntil: new Date(NOW.getTime() - 1), results: [] };
    expect(codes(facts({ check: old }))).toEqual(['COMPLETION_CHECK_EXPIRED']);
  });

  it('the results of the check decide REPO_FINAL_FAILED, RELEASE_CHECK_FAILED, LINK_CHECK_FAILED', () => {
    const base = facts();
    const results = (key: string, ok: boolean) =>
      base.check?.results.map((r) => (r.key === key ? { ...r, ok } : r)) ?? [];
    const check = (list: ReturnType<typeof results>) => ({
      validUntil: base.check?.validUntil ?? null,
      results: list,
    });
    expect(codes(facts({ check: check(results('repo_final', false)) }))).toEqual([
      'REPO_FINAL_FAILED',
    ]);
    expect(codes(facts({ check: check(results('release_alive_web', false)) }))).toEqual([
      'RELEASE_CHECK_FAILED',
    ]);
    expect(codes(facts({ check: check(results('link_https:board', false)) }))).toEqual([
      'LINK_CHECK_FAILED',
    ]);
  });

  it('a check made for another repository or another release address does not count', () => {
    expect(codes(facts({ repositoryId: 8 }))).toEqual(['REPO_FINAL_FAILED']);
    expect(codes(facts({ releaseUrl: 'https://other.release.test/' }))).toEqual([
      'RELEASE_CHECK_FAILED',
    ]);
    expect(codes(facts({ repositoryId: null }))).toEqual(['REPO_FINAL_FAILED']);
  });

  it('fewer than three members: MEMBERS_BELOW_MIN', () => {
    expect(codes(facts({ memberCount: 2 }))).toEqual(['MEMBERS_BELOW_MIN']);
  });

  it('AF-09: 14 days since the first stage opened is enough, 13 are not', () => {
    const stage = (openedDaysAgo: number) =>
      facts().stages.map((s) =>
        s.ordinal === 1
          ? { ...s, openedAt: at(openedDaysAgo), closedAt: at(openedDaysAgo - 2) }
          : s,
      );
    expect(codes(facts({ stages: stage(14) }))).toEqual([]);
    expect(codes(facts({ stages: stage(13.5) }))).toEqual(['DURATION_TOO_SHORT']);
  });

  it('AF-09: contributions on two calendar days: CONTRIBUTION_DAYS_TOO_FEW', () => {
    const two = facts().contributions.map((c, i) => ({
      ...c,
      receivedAt: at(i % 2 === 0 ? 5 : 6),
    }));
    expect(codes(facts({ contributions: two }))).toEqual(['CONTRIBUTION_DAYS_TOO_FEW']);
  });

  it('AF-04: nine merged pull requests and closed issues, or artifacts only: CONTRIBUTION_TOO_LOW', () => {
    const nine = facts().contributions.slice(1);
    expect(codes(facts({ contributions: nine }))).toEqual(['CONTRIBUTION_TOO_LOW']);
    const inactive = facts().contributions.map((c, i) => (i === 0 ? { ...c, active: false } : c));
    expect(codes(facts({ contributions: inactive }))).toContain('CONTRIBUTION_TOO_LOW');
    const artifacts = facts().contributions.map((c) => ({ ...c, source: 'artifact' }));
    expect(codes(facts({ contributions: artifacts }))).toContain('CONTRIBUTION_TOO_LOW');
  });

  it('AF-04: one task credited to two assignees counts once: five tasks with two rows each are CONTRIBUTION_TOO_LOW', () => {
    const rows = facts().contributions.map((c, i) => ({
      ...c,
      source: 'issue',
      ref: `issue:7#${Math.floor(i / 2) + 1}`,
      userId: i % 2 === 0 ? 'u1' : 'u2',
    }));
    const unmet = completionUnmet(facts({ contributions: rows }));
    expect(unmet.map((u) => u.code)).toEqual(['CONTRIBUTION_TOO_LOW']);
    expect(unmet[0]?.data).toMatchObject({ count: 5, min: 10 });
  });

  it('AF-04: the same number as an issue and as a pull request are two items', () => {
    const rows = facts().contributions.map((c, i) => ({
      ...c,
      source: i % 2 === 0 ? 'issue' : 'pr',
      ref: `${i % 2 === 0 ? 'issue' : 'pr'}:7#${Math.floor(i / 2) + 1}`,
    }));
    expect(codes(facts({ contributions: rows }))).toEqual([]);
  });

  it('AF-04: contributions of a single account: CONTRIBUTORS_TOO_FEW', () => {
    const one = facts().contributions.map((c) => ({ ...c, userId: 'u1' }));
    expect(codes(facts({ contributions: one }))).toEqual(['CONTRIBUTORS_TOO_FEW']);
  });

  it('AF-10: a stage closed in under 24 hours: STAGE_CLOSED_TOO_FAST; an open stage is not judged', () => {
    const fast = facts().stages.map((s) =>
      s.ordinal === 2 && s.openedAt
        ? { ...s, closedAt: new Date(s.openedAt.getTime() + 3_600_000) }
        : s,
    );
    expect(codes(facts({ stages: fast }))).toEqual(['STAGE_CLOSED_TOO_FAST']);
    const open = facts().stages.map((s) =>
      s.ordinal === 3 ? { ...s, status: 'open', closedAt: null } : s,
    );
    expect(codes(facts({ stages: open }))).toEqual(['STAGES_NOT_CLOSED']);
  });

  it('AF-02: an address of another completed project or a template address: FRAUD_BLOCK', () => {
    expect(codes(facts({ releaseAddressHeld: true }))).toEqual(['FRAUD_BLOCK']);
    const same = 'https://www.example.com/';
    const check = facts().check;
    const results =
      check?.results.map((r) =>
        r.key.startsWith('release') ? { ...r, data: { url: same } } : r,
      ) ?? [];
    expect(
      codes(facts({ releaseUrl: same, check: { validUntil: check?.validUntil ?? null, results } })),
    ).toEqual(['FRAUD_BLOCK']);
  });

  it('several conditions are all listed', () => {
    const list = codes(facts({ memberCount: 1, releaseAddressHeld: true }));
    expect(list).toEqual(['MEMBERS_BELOW_MIN', 'FRAUD_BLOCK']);
  });
});

describe('release addresses (AF-02)', () => {
  it('example domains and localhost are templates, a host that merely contains the word is not', () => {
    expect(isTemplateAddress('https://example.com/')).toBe(true);
    expect(isTemplateAddress('https://shop.example.org/')).toBe(true);
    expect(isTemplateAddress('https://localhost/')).toBe(true);
    expect(isTemplateAddress('https://notexample.com/')).toBe(false);
  });
});

describe('release addresses, edge cases (AF-02, S6-12)', () => {
  it.each([
    'https://EXAMPLE.COM/',
    'https://example.com./app',
    'https://example.com:8443/app',
    'https://user:pass@example.net/',
    'https://www.example.org',
    'https://a.b.example.net/x',
    'http://localhost:3000',
    'https://localhost./',
    'https://app.localhost/',
  ])('%s is a template address', (address) => {
    expect(isTemplateAddress(address)).toBe(true);
  });

  it.each([
    'https://example.com.evil.test/',
    'https://evil.test/example.com',
    'https://evil.test/?next=https://example.com',
    'https://example.com@evil.test/',
    'https://myexample.org/',
    'https://my-localhost.test/',
    'https://xn--80akhbyknj4f.test/',
    'not an address',
    '',
  ])('%s is not', (address) => {
    expect(isTemplateAddress(address)).toBe(false);
  });
});

describe('overdueDaysOf (FR-WORK-12)', () => {
  it('rounds up, never below zero', () => {
    const planned = new Date('2026-03-01T00:00:00Z');
    expect(overdueDaysOf(planned, new Date('2026-02-20T00:00:00Z'))).toBe(0);
    expect(overdueDaysOf(planned, planned)).toBe(0);
    expect(overdueDaysOf(planned, new Date('2026-03-01T00:00:01Z'))).toBe(1);
    expect(overdueDaysOf(planned, new Date('2026-03-03T00:00:00Z'))).toBe(2);
  });
});
