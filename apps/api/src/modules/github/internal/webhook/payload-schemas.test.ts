import { describe, expect, it } from 'vitest';
import { issuesEvent, pullRequestEvent, readEnvelope } from './payload-schemas.js';

const issue = {
  number: 3,
  title: 'Баг',
  html_url: 'https://github.com/o/r/issues/3',
  state: 'closed',
  user: { id: 7, login: 'a', type: 'User' },
  assignees: [{ id: 8, login: 'b' }],
  labels: [{ name: 'role:backend', color: 'fff' }],
  updated_at: '2026-10-18T10:00:00Z',
  closed_at: '2026-10-18T10:00:00Z',
  reactions: { total_count: 0 },
};
const envelope = {
  action: 'closed',
  repository: { id: 5, full_name: 'o/r', private: false },
  installation: { id: 9 },
  sender: { id: 7 },
};

describe('webhook payload schemas (SEC-06)', () => {
  it('reads the fields it uses and drops the rest', () => {
    const parsed = issuesEvent.parse({ ...envelope, issue });
    expect(parsed.issue.assignees).toEqual([{ id: 8 }]);
    expect(parsed.issue.labels).toEqual([{ name: 'role:backend' }]);
    expect('reactions' in parsed.issue).toBe(false);
  });

  it('requires what the worker relies on', () => {
    const withoutNumber: Record<string, unknown> = { ...issue };
    delete withoutNumber['number'];
    expect(issuesEvent.safeParse({ ...envelope, issue: withoutNumber }).success).toBe(false);
    expect(issuesEvent.safeParse({ ...envelope, issue, installation: {} }).success).toBe(false);
    expect(
      issuesEvent.safeParse({ ...envelope, issue: { ...issue, state: 'weird' } }).success,
    ).toBe(false);
    expect(
      issuesEvent.safeParse({ ...envelope, issue: { ...issue, updated_at: 'yesterday' } }).success,
    ).toBe(false);
  });

  it('defaults a pull request that says nothing about merging to not merged', () => {
    const parsed = pullRequestEvent.parse({ ...envelope, pull_request: issue });
    expect(parsed.pull_request.merged).toBe(false);
  });

  it('reads the envelope of any signed object without trusting it', () => {
    expect(readEnvelope(envelope)).toEqual({
      action: 'closed',
      installationId: 9,
      repositoryId: 5,
      removedRepositoryIds: [],
    });
    expect(
      readEnvelope({
        action: 1,
        installation: { id: '9' },
        repository: null,
        repositories_removed: [{ id: 4 }, { id: 'x' }, 7],
      }),
    ).toEqual({
      action: null,
      installationId: null,
      repositoryId: null,
      removedRepositoryIds: [4],
    });
  });
});
