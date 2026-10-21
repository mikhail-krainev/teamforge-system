import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import {
  type ActorContext,
  ActorPolicies,
  type ActorPolicy,
} from '../../../../platform/authz/actor-policies.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import type { CompletionSnapshot } from '../domain/completion-snapshot.js';
import { CompletionRepository } from '../repositories/completion.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The policy runs before the validation of the path, so a malformed id is refused here (400), not by the database (500). */
function teamIdOf(ctx: ActorContext): string {
  const params = (ctx.request.params ?? {}) as Record<string, string | undefined>;
  const teamId = params['teamId'];
  if (teamId === undefined) throw new DomainError('NOT_FOUND', 404);
  if (!UUID.test(teamId)) {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/teamId', code: 'format', message: 'Must be a UUID' }],
    });
  }
  return teamId;
}

/**
 * `team-participant` (architecture 13.14): an active member of the team, or a person of the record of the
 * completion (a member who left before it stays in `departedUserIds`). Anyone else gets 404, exactly as
 * for a team that does not exist.
 */
export function teamParticipantPolicy(
  tx: TxRunner,
  teams: TeamsApi,
  completions: CompletionRepository,
): ActorPolicy {
  return {
    requiresSession: true,
    async check(ctx) {
      const userId = ctx.userId;
      if (userId === undefined) throw new DomainError('UNAUTHENTICATED', 401);
      const teamId = teamIdOf(ctx);
      const allowed = await tx.run(async () => {
        const roster = await teams.getRoster(teamId);
        if (roster.some((member) => member.userId === userId)) return true;
        const completion = await completions.findCompletion(teamId);
        const snapshot = completion?.snapshot as CompletionSnapshot | undefined;
        if (snapshot === undefined) return false;
        return (
          snapshot.roster.members.some((member) => member.userId === userId) ||
          snapshot.roster.departedUserIds.includes(userId)
        );
      });
      if (!allowed) throw new DomainError('NOT_FOUND', 404);
    },
  };
}

/** Registers the actor policy of workspace. The worker has no routes, hence no `ActorPolicies`. */
@Injectable()
export class WorkspaceOperations implements OnModuleInit {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Optional() @Inject(ActorPolicies) private readonly policies?: ActorPolicies,
  ) {}

  onModuleInit(): void {
    if (this.policies === undefined) return;
    if (this.policies.get('team-participant') !== undefined) return;
    this.policies.register(
      'team-participant',
      teamParticipantPolicy(this.tx, this.teams, this.completions),
    );
  }
}
