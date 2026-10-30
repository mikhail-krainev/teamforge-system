import { Inject, Injectable } from '@nestjs/common';
import { WORKSPACE_API, type WorkspaceApi } from '../../../workspace/public.js';
import type { AwardView, CounterView, CreditStatusView, RewardsApi } from '../../public.js';
import { RewardsReadService } from './rewards-read.service.js';

/** What the other modules may ask of rewards (architecture 3.8). */
@Injectable()
export class RewardsFacade implements RewardsApi {
  constructor(
    @Inject(RewardsReadService) private readonly reads: RewardsReadService,
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
  ) {}

  getUserAwards(userId: string): Promise<AwardView[]> {
    return this.reads.awardsOf(userId);
  }

  getCounters(userId: string): Promise<CounterView> {
    return this.reads.countersOf(userId);
  }

  async getCreditStatus(teamId: string, userId: string): Promise<CreditStatusView | null> {
    const completion = await this.workspace.getCompletion(teamId);
    if (completion === null) return null;
    const snapshot = await this.workspace.getCompletionSnapshot(teamId);
    const participant =
      snapshot.roster.members.some((m) => m.userId === userId) ||
      snapshot.roster.departedUserIds.includes(userId);
    return participant ? this.reads.creditOf(teamId, userId) : null;
  }
}
