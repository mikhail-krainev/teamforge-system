import type { ActorContext, ActorPolicy } from '../../../../platform/authz/actor-policies.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';

/** What the policies need to know; the repository implements it, tests replace it. */
export interface TeamAccess {
  /** `undefined` when the team does not exist. */
  getTeamLead(teamId: string): Promise<{ leadUserId: string | null } | undefined>;
  isActiveMember(teamId: string, userId: string): Promise<boolean>;
  /** Active or former member (`left`, `removed`): the replay of a leave must still reach the interceptor. */
  wasEverMember(teamId: string, userId: string): Promise<boolean>;
  /** The offer with the current lead of its team; `undefined` when it does not exist. */
  getOfferParties(
    offerId: string,
  ): Promise<{ teamId: string; userId: string; leadUserId: string | null } | undefined>;
  /** `undefined` when the vote does not belong to the team. */
  getVoteRole(
    teamId: string,
    voteId: string,
    userId: string,
  ): Promise<{ participant: boolean } | undefined>;
}

/** Foreign or missing resources look the same (architecture 13.14, point 3). */
export function notFound(): DomainError {
  return new DomainError('NOT_FOUND', 404);
}

function param(ctx: ActorContext, name: string): string {
  const params = (ctx.request.params ?? {}) as Record<string, string | undefined>;
  const value = params[name];
  if (value === undefined) throw notFound();
  return value;
}

function sessionUser(ctx: ActorContext): string {
  if (ctx.userId === undefined) throw new DomainError('UNAUTHENTICATED', 401);
  return ctx.userId;
}

/**
 * `team-member`: an active member of `teamId`; anyone else gets 404. `leaveTeam` also lets a former
 * member through: the guard runs before the idempotency interceptor, and a retry of a finished
 * leave with the same key must replay its 204; a new key finds no active membership (404 in the
 * service).
 */
export function teamMemberPolicy(access: TeamAccess): ActorPolicy {
  return {
    requiresSession: true,
    async check(ctx) {
      const teamId = param(ctx, 'teamId');
      const userId = sessionUser(ctx);
      const allowed =
        ctx.operationId === 'leaveTeam'
          ? await access.wasEverMember(teamId, userId)
          : await access.isActiveMember(teamId, userId);
      if (!allowed) throw notFound();
    },
  };
}

/** `team-lead`: the current lead of `teamId`; a member who is not the lead gets 403 NOT_TEAM_LEAD. */
export function teamLeadPolicy(access: TeamAccess): ActorPolicy {
  return {
    requiresSession: true,
    async check(ctx) {
      const teamId = param(ctx, 'teamId');
      const userId = sessionUser(ctx);
      if (!(await access.isActiveMember(teamId, userId))) throw notFound();
      const team = await access.getTeamLead(teamId);
      if (team === undefined) throw notFound();
      if (team.leadUserId !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
    },
  };
}

/**
 * `offer-party`: the addressee of the offer or the current lead of the offer's team; anyone else
 * gets 404. Which of the two may do what (direction, accept / reject / cancel) is decided by the
 * service under the ticket lock.
 */
export function offerPartyPolicy(access: TeamAccess): ActorPolicy {
  return {
    requiresSession: true,
    async check(ctx) {
      const userId = sessionUser(ctx);
      const offer = await access.getOfferParties(param(ctx, 'offerId'));
      if (offer === undefined) throw notFound();
      if (offer.userId !== userId && offer.leadUserId !== userId) throw notFound();
    },
  };
}

/**
 * `invitee`: the holder of an invitation token. The token is in the body and is validated after
 * this guard, so the policy only needs a session; the token, expiry and the match with
 * `github_user_id` / email HMAC are checked by the service under the invitation lock.
 */
export function inviteePolicy(): ActorPolicy {
  return { requiresSession: true, check: () => undefined };
}

/**
 * `vote-participant`: the vote must belong to `teamId` and the user must be in the team (else 404);
 * a team member who is neither eligible, candidate nor offered gets 403 NOT_ELIGIBLE.
 */
export function voteParticipantPolicy(access: TeamAccess): ActorPolicy {
  return {
    requiresSession: true,
    async check(ctx) {
      const userId = sessionUser(ctx);
      const role = await access.getVoteRole(param(ctx, 'teamId'), param(ctx, 'voteId'), userId);
      if (role === undefined) throw notFound();
      if (!role.participant) throw new DomainError('NOT_ELIGIBLE', 403);
    },
  };
}
