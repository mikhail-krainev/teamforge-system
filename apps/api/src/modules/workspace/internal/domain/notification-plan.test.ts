import { describe, expect, it } from 'vitest';
import { planNotifications, type TeamAudience } from './notification-plan.js';
import { realtimeSignals } from './realtime-events.js';

const TEAM = 'team-1';
const audience: TeamAudience = { leadUserId: 'lead', memberUserIds: ['lead', 'a', 'b'] };
const lookup = (): Promise<TeamAudience | null> => Promise.resolve(audience);

const plan = (name: string, payload: Record<string, unknown>) =>
  planNotifications({ id: 'e1', name, payload }, lookup);

describe('planNotifications (FR-WORK-19)', () => {
  it('an offer from the lead goes to the candidate, a request goes to the lead', async () => {
    const offer = await plan('teams.offer_created', {
      offerId: 'o1',
      teamId: TEAM,
      userId: 'cand',
      direction: 'lead_to_user',
    });
    expect(offer.map((d) => [d.userId, d.type])).toEqual([['cand', 'seat_offer']]);
    const request = await plan('teams.offer_created', {
      offerId: 'o2',
      teamId: TEAM,
      userId: 'cand',
      direction: 'user_to_lead',
    });
    expect(request.map((d) => [d.userId, d.type])).toEqual([['lead', 'join_request']]);
  });

  it('an opened seat is announced to the members except the lead', async () => {
    const drafts = await plan('teams.seat_opened', { seatId: 's1', teamId: TEAM });
    expect(drafts.map((d) => d.userId)).toEqual(['a', 'b']);
    expect(new Set(drafts.map((d) => d.dedupeKey)).size).toBe(1);
  });

  it('FR-GH-07: an unlinked repository is told to the lead with the reason code, but not when the lead did it himself', async () => {
    const drafts = await plan('github.repo_unlinked', {
      teamId: TEAM,
      repositoryId: 7,
      reason: 'installation_deleted',
    });
    expect(drafts).toEqual([
      {
        userId: 'lead',
        type: 'repo_unlinked',
        dedupeKey: 'repo_unlinked:e1',
        payload: { teamId: TEAM, reason: 'installation_deleted' },
      },
    ]);
    expect(
      await plan('github.repo_unlinked', { teamId: TEAM, repositoryId: 7, reason: 'lead' }),
    ).toEqual([]);
    expect(
      await plan('github.repo_unlinked', { repositoryId: 7, reason: 'installation_deleted' }),
    ).toEqual([]);
  });

  it('a new lead is announced to everybody; a vote opens and closes for all members', async () => {
    expect(
      (await plan('teams.lead_changed', { teamId: TEAM, toUserId: 'a' })).map((d) => d.userId),
    ).toEqual(['lead', 'a', 'b']);
    const opened = await plan('teams.vote_updated', {
      teamId: TEAM,
      voteId: 'v1',
      status: 'nominating',
    });
    expect(opened.every((d) => d.type === 'vote_opened')).toBe(true);
    expect(
      await plan('teams.vote_updated', { teamId: TEAM, voteId: 'v1', status: 'voting' }),
    ).toEqual([]);
  });

  it('the joiner himself is not told that he joined; payloads carry ids only', async () => {
    expect(await plan('teams.member_joined', { teamId: TEAM, userId: 'lead' })).toEqual([]);
    const drafts = await plan('teams.member_joined', { teamId: TEAM, userId: 'a' });
    expect(drafts).toHaveLength(1);
    expect(Object.keys(drafts[0]?.payload ?? {})).toEqual(['teamId', 'userId']);
  });

  it('unknown events and malformed payloads create nothing', async () => {
    expect(await plan('teams.seat_closed', { teamId: TEAM })).toEqual([]);
    expect(await plan('teams.offer_created', { teamId: TEAM })).toEqual([]);
  });
});

describe('realtimeSignals (architecture 9)', () => {
  it('maps team changes to team.updated on the team channel', () => {
    expect(
      realtimeSignals({ name: 'teams.team_updated', payload: { teamId: TEAM, version: 3 } }),
    ).toEqual([
      { channel: `team:${TEAM}`, type: 'team.updated', data: { teamId: TEAM, version: 3 } },
    ]);
  });

  it('maps a notification to the user channel and a leaver to member.left', () => {
    const [note] = realtimeSignals({
      name: 'workspace.notification_created',
      payload: { userId: 'u', notificationId: 'n' },
    });
    expect(note).toMatchObject({ channel: 'user:u', type: 'notification.created' });
    const [left] = realtimeSignals({
      name: 'teams.member_left',
      payload: { teamId: TEAM, userId: 'u' },
    });
    expect(left).toMatchObject({ channel: `team:${TEAM}`, type: 'member.left' });
  });

  it('ignores events without the ids it needs', () => {
    expect(realtimeSignals({ name: 'teams.member_joined', payload: {} })).toEqual([]);
    expect(realtimeSignals({ name: 'unknown.event', payload: { teamId: TEAM } })).toEqual([]);
  });
});
