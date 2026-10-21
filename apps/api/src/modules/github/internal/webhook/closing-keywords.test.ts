import { describe, expect, it } from 'vitest';
import { closedIssueNumbers } from './closing-keywords.js';

describe('closedIssueNumbers (FR-GH-05)', () => {
  it('reads the closing keywords in any case and form', () => {
    expect(closedIssueNumbers('Fixes #12 and closes: #3, RESOLVED #7')).toEqual([12, 3, 7]);
  });

  it('ignores mentions that close nothing and other repositories', () => {
    expect(closedIssueNumbers('See #4. Related to #5. fixes owner/repo#6')).toEqual([]);
  });

  it('counts a number once and survives an empty body', () => {
    expect(closedIssueNumbers('Fixes #2, fixes #2')).toEqual([2]);
    expect(closedIssueNumbers(null)).toEqual([]);
    expect(closedIssueNumbers('')).toEqual([]);
  });
});
