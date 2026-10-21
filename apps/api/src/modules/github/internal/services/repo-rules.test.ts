import { describe, expect, it } from 'vitest';
import { isOlderThanThirtyDays, rejectionsOf } from './repo-rules.js';

const plain = { archived: false, isPrivate: false, isFork: false };

describe('rejectionsOf', () => {
  it('accepts a public, live repository that is not a fork', () => {
    expect(rejectionsOf(plain, false)).toEqual([]);
  });

  it('a repository the installation cannot see says only that, whatever the other facts', () => {
    expect(rejectionsOf(null, true)).toEqual(['REPO_NOT_IN_INSTALLATION']);
  });

  it('names every reason, in a stable order', () => {
    expect(rejectionsOf({ archived: true, isPrivate: true, isFork: true }, false)).toEqual([
      'REPO_ARCHIVED',
      'REPO_NOT_PUBLIC',
      'REPO_FORK',
    ]);
  });

  it('a fork with commits of its own is accepted', () => {
    expect(rejectionsOf({ ...plain, isFork: true }, true)).toEqual([]);
    expect(rejectionsOf({ ...plain, isFork: true }, false)).toEqual(['REPO_FORK']);
  });
});

describe('isOlderThanThirtyDays', () => {
  const start = new Date('2026-10-18T00:00:00Z');
  it('is true only past the thirtieth day', () => {
    expect(isOlderThanThirtyDays(new Date('2026-09-18T00:00:00Z'), start)).toBe(false);
    expect(isOlderThanThirtyDays(new Date('2026-09-17T23:59:59Z'), start)).toBe(true);
  });
});
