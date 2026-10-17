import { Inject, Injectable } from '@nestjs/common';
import type { Body, Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { RouteRepository } from '../repositories/route.repository.js';
import { TransitionRepository } from '../repositories/transition.repository.js';

const MAX_ORDINAL = 32_767;

function invalid(pointer: string, message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, { errors: [{ pointer, message }] });
}

/**
 * confirmParticipation (FR-WORK-11): the lead confirms that a member took part in a stage. The
 * team id comes from the path only; the member must be on this team's roster (13.14). The
 * confirmation is a fact: repeating it keeps the first record.
 */
@Injectable()
export class ParticipationService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(RouteRepository) private readonly route: RouteRepository,
    @Inject(TransitionRepository) private readonly transitions: TransitionRepository,
  ) {}

  confirm(
    leadId: string,
    teamId: string,
    body: Body<'confirmParticipation'>,
  ): Promise<Ok<'confirmParticipation'>> {
    return this.tx.run(async () => {
      const team = await this.teams.lockTeam(teamId, 'share');
      if (team.leadUserId !== leadId) throw new DomainError('NOT_TEAM_LEAD', 403);
      const stage =
        body.stageOrdinal > MAX_ORDINAL
          ? undefined
          : await this.route.findStage(teamId, body.stageOrdinal);
      if (stage === undefined) throw new DomainError('NOT_FOUND', 404);
      if (stage.status === 'pending') {
        throw invalid('/stageOrdinal', 'The stage has not started yet');
      }
      const roster = await this.teams.getRoster(teamId);
      if (!roster.some((m) => m.userId === body.userId)) {
        throw invalid('/userId', 'The person is not an active member of the team');
      }
      const row = await this.transitions.confirm({
        teamId,
        userId: body.userId,
        stageOrdinal: body.stageOrdinal,
        confirmedBy: leadId,
        at: this.clock.now(),
      });
      return {
        userId: row.userId,
        stageOrdinal: row.stageOrdinal,
        confirmedBy: row.confirmedBy,
        at: row.at.toISOString(),
      };
    });
  }
}
