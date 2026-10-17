import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { assertTeamWritable } from './item-gate.js';

/**
 * transitionStage (S5-08). Only the entry gate exists so far: the lead of a team that can change
 * (FR-WORK-18: 409 in `suspended` and `voting`). The transition itself answers 501 until S5-08
 * adds the checks of FR-WORK-10 and the move to the next stage.
 */
@Injectable()
export class StageTransitionService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
  ) {}

  transition(leadId: string, teamId: string): Promise<Ok<'transitionStage'>> {
    return this.tx.run(async () => {
      const team = await this.teams.lockTeam(teamId);
      if (team.leadUserId !== leadId) throw new DomainError('NOT_TEAM_LEAD', 403);
      assertTeamWritable(team.status, true);
      throw new DomainError('INTERNAL', 501, { detail: 'Stage transitions arrive with S5-08' });
    });
  }
}
