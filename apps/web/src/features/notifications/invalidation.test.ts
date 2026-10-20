import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ME_QUERY_KEY } from '@/features/auth/session';
import { teamKey } from '@/features/teams/api';
import { createInvalidator } from '@/lib/realtime';
import { keysFor } from './invalidation';

const ID = '0192f0a0-7c1e-7b3a-8d2f-00000000a001';

describe('keysFor', () => {
  it('notification.created refreshes the bell', () => {
    expect(keysFor({ type: 'notification.created', channel: `user:${ID}` })).toEqual([
      ['notifications'],
    ]);
  });

  it('vote.updated refreshes the vote and the team of the CHANNEL', () => {
    const keys = keysFor({ type: 'vote.updated', channel: `team:${ID}` });
    expect(keys).toContainEqual(['votes', ID]);
    expect(keys).toContainEqual(['teams', 'detail', ID]);
  });

  it('member events refresh the roster, lists and offers', () => {
    const keys = keysFor({ type: 'member.left', channel: `team:${ID}` });
    expect(keys).toContainEqual(['teams', 'detail', ID]);
    expect(keys).toContainEqual(['teams', 'list']);
    expect(keys).toContainEqual(['offers']);
  });

  it('application.changed (queue, auto-add) refreshes the application, teams, demand and recommendations', () => {
    const keys = keysFor({ type: 'application.changed', channel: `user:${ID}` });
    expect(keys).toContainEqual(['applications']);
    expect(keys).toContainEqual(['teams']);
    expect(keys).toContainEqual(['demand']);
    expect(keys).toContainEqual(['recommendations']);
  });

  it('team events refresh the demand and the recommendations of seats and candidates', () => {
    const keys = keysFor({ type: 'member.joined', channel: `team:${ID}` });
    expect(keys).toContainEqual(['demand']);
    expect(keys).toContainEqual(['recommendations']);
  });

  it('stage events refresh the whole workspace of the project and the team', () => {
    for (const type of ['stage.opened', 'stage.closed']) {
      const keys = keysFor({ type, channel: `team:${ID}` });
      expect(keys).toContainEqual(['workspace', ID]);
      expect(keys).toContainEqual(teamKey(ID));
    }
  });

  it('item events do not re-read the checklists under an open form (FR-WORK-07)', () => {
    const keys = keysFor({ type: 'item.updated', channel: `team:${ID}` });
    expect(keys).not.toContainEqual(['workspace', ID]);
  });

  it('session.revoked re-reads the current user', () => {
    expect(keysFor({ type: 'session.revoked', channel: `user:${ID}` })).toEqual([ME_QUERY_KEY]);
  });

  it('an unknown user event refreshes nothing', () => {
    expect(keysFor({ type: 'something.new', channel: `user:${ID}` })).toEqual([]);
  });
});

describe('createInvalidator', () => {
  it('marks matching queries stale on a signal and everything on reconnect', () => {
    const client = new QueryClient();
    client.setQueryData(['votes', ID], []);
    client.setQueryData(['other'], 1);
    const invalidator = createInvalidator(client, keysFor);
    invalidator.onSignal({ type: 'vote.updated', channel: `team:${ID}` });
    expect(client.getQueryState(['votes', ID])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['other'])?.isInvalidated).toBe(false);
    invalidator.onReconnected();
    expect(client.getQueryState(['other'])?.isInvalidated).toBe(true);
  });
});
