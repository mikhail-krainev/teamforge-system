import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ActorContext, ActorPolicy } from '../../../../platform/authz/actor-policies.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import type { TeamAccess } from './team-actor-policies.js';
import { teamActorPolicies } from './team-operations.js';
import { ActorPolicies } from '../../../../platform/authz/actor-policies.js';

const TEAM = 'team-1';
const LEAD = 'lead';
const MEMBER = 'member';
const OUTSIDER = 'outsider';

const access: TeamAccess = {
  getTeamLead: (id) => Promise.resolve(id === TEAM ? { leadUserId: LEAD } : undefined),
  isActiveMember: (id, user) => Promise.resolve(id === TEAM && [LEAD, MEMBER].includes(user)),
  getOfferParties: (id) =>
    Promise.resolve(
      id === 'offer-1' ? { teamId: TEAM, userId: 'invited', leadUserId: LEAD } : undefined,
    ),
  getVoteRole: (team, vote, user) =>
    Promise.resolve(
      team === TEAM && vote === 'vote-1' && [LEAD, MEMBER].includes(user)
        ? { participant: user === MEMBER }
        : undefined,
    ),
};

const policies = teamActorPolicies(access);

function ctx(userId: string | undefined, params: Record<string, string>): ActorContext {
  return {
    operationId: 'op',
    request: { params } as unknown as FastifyRequest,
    authz: { actor: 'x' },
    userId,
  };
}

async function outcome(actor: string, c: ActorContext): Promise<string> {
  try {
    await (policies[actor] as ActorPolicy).check(c);
    return 'allowed';
  } catch (error) {
    if (error instanceof DomainError) return `${error.status} ${error.code}`;
    throw error;
  }
}

describe('team actor policies (architecture 13.14)', () => {
  it('registers exactly the five actors of slice 3, all needing a session', () => {
    expect(Object.keys(policies).sort()).toEqual([
      'invitee',
      'offer-party',
      'team-lead',
      'team-member',
      'vote-participant',
    ]);
    for (const policy of Object.values(policies)) expect(policy.requiresSession).toBe(true);
  });

  it('can be registered in ActorPolicies without clashing with the built-ins', () => {
    const registry = new ActorPolicies();
    for (const [actor, policy] of Object.entries(policies)) registry.register(actor, policy);
    expect(registry.get('team-lead')).toBe(policies['team-lead']);
  });

  it('team-member: a member passes, an outsider and a foreign team get 404', async () => {
    expect(await outcome('team-member', ctx(MEMBER, { teamId: TEAM }))).toBe('allowed');
    expect(await outcome('team-member', ctx(OUTSIDER, { teamId: TEAM }))).toBe('404 NOT_FOUND');
    expect(await outcome('team-member', ctx(MEMBER, { teamId: 'other' }))).toBe('404 NOT_FOUND');
  });

  it('team-lead: the lead passes, a member gets 403 NOT_TEAM_LEAD, an outsider 404', async () => {
    expect(await outcome('team-lead', ctx(LEAD, { teamId: TEAM }))).toBe('allowed');
    expect(await outcome('team-lead', ctx(MEMBER, { teamId: TEAM }))).toBe('403 NOT_TEAM_LEAD');
    expect(await outcome('team-lead', ctx(OUTSIDER, { teamId: TEAM }))).toBe('404 NOT_FOUND');
  });

  it('offer-party: the addressee and the lead pass, everybody else gets 404', async () => {
    expect(await outcome('offer-party', ctx('invited', { offerId: 'offer-1' }))).toBe('allowed');
    expect(await outcome('offer-party', ctx(LEAD, { offerId: 'offer-1' }))).toBe('allowed');
    expect(await outcome('offer-party', ctx(MEMBER, { offerId: 'offer-1' }))).toBe('404 NOT_FOUND');
    expect(await outcome('offer-party', ctx(LEAD, { offerId: 'missing' }))).toBe('404 NOT_FOUND');
  });

  it('invitee: any signed-in user reaches the service, which checks the token', async () => {
    expect(await outcome('invitee', ctx(OUTSIDER, {}))).toBe('allowed');
  });

  it('vote-participant: participant passes, other member 403 NOT_ELIGIBLE, rest 404', async () => {
    const params = { teamId: TEAM, voteId: 'vote-1' };
    expect(await outcome('vote-participant', ctx(MEMBER, params))).toBe('allowed');
    expect(await outcome('vote-participant', ctx(LEAD, params))).toBe('403 NOT_ELIGIBLE');
    expect(await outcome('vote-participant', ctx(OUTSIDER, params))).toBe('404 NOT_FOUND');
    expect(await outcome('vote-participant', ctx(MEMBER, { ...params, voteId: 'x' }))).toBe(
      '404 NOT_FOUND',
    );
  });

  it('every policy answers 401 without a session user', async () => {
    for (const actor of ['team-member', 'team-lead', 'offer-party', 'vote-participant']) {
      expect(
        await outcome(actor, ctx(undefined, { teamId: TEAM, offerId: 'offer-1', voteId: 'vote-1' })),
      ).toBe('401 UNAUTHENTICATED');
    }
  });
});
