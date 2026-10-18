import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { InvariantError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type {
  GithubApi,
  GithubContributionSource,
  RepoExistsResult,
  RepoLinkView,
} from '../../public.js';
import { ItemRepository } from '../webhook/item.repository.js';
import { repoCheck } from '../schema/repo.js';
import { RepoInspectionService } from './repo-inspection.service.js';
import { RepoLinkRepository } from './repo-link.repository.js';

const NO_REPOSITORY = 'NO_REPOSITORY';

/** What other modules may ask of github (architecture 3.7). */
@Injectable()
export class GithubFacade implements GithubApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(RepoInspectionService) private readonly inspection: RepoInspectionService,
    @Inject(ItemRepository) private readonly items: ItemRepository,
  ) {}

  async getRepoLink(teamId: string): Promise<RepoLinkView | null> {
    const row = await this.links.findHolding(teamId);
    if (row === undefined) return null;
    return {
      teamId,
      repositoryId: row.repositoryId,
      installationId: row.installationId,
      fullName: row.fullName,
      status: row.status as RepoLinkView['status'],
      isPrivate: row.isPrivate,
      repoCreatedAt: row.repoCreatedAt,
    };
  }

  async checkRepositoryExists(teamId: string): Promise<RepoExistsResult> {
    const link = await this.links.findHolding(teamId);
    const checkedAt = this.clock.now();
    if (link === undefined) return { ok: false, reasons: [NO_REPOSITORY], checkedAt };
    const { rejections } = await this.inspection.inspect(link.installationId, link.repositoryId);
    const result = { ok: rejections.length === 0, reasons: rejections as string[], checkedAt };
    await this.tx.tx.insert(repoCheck).values({
      id: uuidv7(),
      teamId,
      repositoryId: link.repositoryId,
      kind: 'exists',
      ok: result.ok,
      details: { reasons: result.reasons },
      checkedAt,
    });
    return result;
  }

  async isContributionSourceStanding(
    source: GithubContributionSource,
    repositoryId: number,
    number: number,
  ): Promise<boolean | null> {
    const item = await this.items.find(repositoryId, source, number);
    if (item === undefined) return null;
    return source === 'pr' ? item.merged : item.state === 'closed';
  }

  async markRepositoryCompleted(teamId: string): Promise<void> {
    if (!this.tx.isActive()) {
      throw new InvariantError(
        'markRepositoryCompleted must run inside the completion transaction',
      );
    }
    await this.links.markCompleted(teamId);
  }
}
