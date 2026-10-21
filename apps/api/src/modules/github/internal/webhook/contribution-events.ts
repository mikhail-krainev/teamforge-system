import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import {
  type ContributionDetectedPayload,
  type ContributionRevokedPayload,
  contributionRef,
  GITHUB_MODULE,
  type GithubContributionSource,
} from '../../public.js';
import type { ItemRow } from './item.repository.js';

export interface DetectedWork {
  teamId: string;
  source: GithubContributionSource;
  item: Pick<ItemRow, 'repositoryId' | 'number' | 'title' | 'htmlUrl' | 'labels'>;
  userIds: string[];
  occurredAt: Date;
  receivedAt: Date;
}

/** Writes `github.contribution_detected` and `github.contribution_revoked` in the caller's transaction. */
@Injectable()
export class ContributionEvents {
  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}

  async detected(work: DetectedWork): Promise<string[]> {
    if (work.userIds.length === 0) return [];
    const payload: ContributionDetectedPayload = {
      v: 1,
      teamId: work.teamId,
      repositoryId: work.item.repositoryId,
      source: work.source,
      ref: contributionRef(work.source, work.item.repositoryId, work.item.number),
      number: work.item.number,
      title: work.item.title,
      url: work.item.htmlUrl,
      userIds: [...new Set(work.userIds)],
      labels: work.item.labels,
      occurredAt: work.occurredAt.toISOString(),
      receivedAt: work.receivedAt.toISOString(),
    };
    const id = await this.outbox.publish({
      module: GITHUB_MODULE,
      type: 'contribution_detected',
      aggregateId: work.teamId,
      payload: { ...payload },
    });
    return [id];
  }

  async revoked(
    teamId: string,
    source: GithubContributionSource,
    item: Pick<ItemRow, 'repositoryId' | 'number'>,
  ): Promise<string[]> {
    const payload: ContributionRevokedPayload = {
      v: 1,
      teamId,
      repositoryId: item.repositoryId,
      source,
      ref: contributionRef(source, item.repositoryId, item.number),
    };
    const id = await this.outbox.publish({
      module: GITHUB_MODULE,
      type: 'contribution_revoked',
      aggregateId: teamId,
      payload: { ...payload },
    });
    return [id];
  }
}
