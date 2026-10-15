import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ActorPolicies, type ActorPolicy } from '../../../../platform/authz/actor-policies.js';
import { TeamAccessRepository } from '../repositories/team-access.repository.js';
import {
  inviteePolicy,
  offerPartyPolicy,
  teamLeadPolicy,
  teamMemberPolicy,
  voteParticipantPolicy,
  type TeamAccess,
} from './team-actor-policies.js';

/** Actors owned by this module, keyed by the `x-authz.actor` value. */
export function teamActorPolicies(access: TeamAccess): Record<string, ActorPolicy> {
  return {
    'team-member': teamMemberPolicy(access),
    'team-lead': teamLeadPolicy(access),
    'offer-party': offerPartyPolicy(access),
    invitee: inviteePolicy(),
    'vote-participant': voteParticipantPolicy(access),
  };
}

/** Registers the actor policies of teams. The worker has no routes, hence no `ActorPolicies`. */
@Injectable()
export class TeamOperations implements OnModuleInit {
  constructor(
    @Inject(TeamAccessRepository) private readonly access: TeamAccessRepository,
    @Optional() @Inject(ActorPolicies) private readonly policies?: ActorPolicies,
  ) {}

  onModuleInit(): void {
    if (this.policies === undefined) return;
    for (const [actor, policy] of Object.entries(teamActorPolicies(this.access))) {
      if (this.policies.get(actor) === undefined) this.policies.register(actor, policy);
    }
  }
}
