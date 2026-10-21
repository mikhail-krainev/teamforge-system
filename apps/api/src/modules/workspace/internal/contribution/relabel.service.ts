import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { CONTRIBUTION_RECORDED } from '../events/contribution.consumer.js';
import { ContributionRepository } from '../repositories/contribution.repository.js';
import { type FeedEntryDto, toFeedEntry } from '../feed/feed.service.js';

/**
 * relabelContribution (FR-WORK-17, FR-REW-02, architecture 7.6, 12.3): a member moves his own contribution
 * to another role he holds, while the project is `active`. Lock #4 `team FOR SHARE` keeps the status
 * (and the completion, which takes the lock exclusively and fixes the labels) out of the way; the write
 * is one UPDATE of the row, so any number of relabels at once ends on one of the labels.
 */
@Injectable()
export class RelabelService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ContributionRepository) private readonly contributions: ContributionRepository,
  ) {}

  relabel(
    userId: string,
    teamId: string,
    contributionId: string,
    body: Body<'relabelContribution'>,
  ): Promise<FeedEntryDto> {
    return this.tx.run(async () => {
      const team = await this.teams.lockTeam(teamId, 'share');
      if (team.status === 'completed' || team.status === 'archived') {
        throw new DomainError('INVALID_STATE', 409);
      }
      if (team.status !== 'active') throw new DomainError('TEAM_STATUS_BLOCKS_ACTION', 409);
      const own = await this.contributions.findOwn(teamId, contributionId, userId);
      if (own === undefined) throw new DomainError('NOT_FOUND', 404);
      const roster = await this.teams.getRoster(teamId);
      const held = roster.find((member) => member.userId === userId)?.roles ?? [];
      if (!held.some((role) => role.roleCode === body.roleCode)) {
        throw new DomainError('VALIDATION_FAILED', 422, {
          errors: [{ pointer: '/roleCode', message: 'The role is not held by the member' }],
        });
      }
      if (own.roleCode === body.roleCode) return toFeedEntry(own);
      const changed = await this.contributions.setRole(contributionId, body.roleCode);
      if (changed === undefined) throw new DomainError('INVALID_STATE', 409);
      await this.outbox.publish({
        module: WORKSPACE_MODULE,
        type: CONTRIBUTION_RECORDED,
        aggregateId: teamId,
        payload: { teamId, contributionId, at: this.clock.now().toISOString() },
      });
      return toFeedEntry(changed);
    });
  }
}
