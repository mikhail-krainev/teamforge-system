import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { InvariantError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type {
  AccountCheckView,
  AccountEligibility,
  GithubApi,
  GithubContributionSource,
  PullRequestStats,
  RepoExistsResult,
  RepoFinalResult,
  RepoLinkView,
  RepositoryFacts,
} from '../../public.js';
import { ItemRepository } from '../webhook/item.repository.js';
import { AntifraudFactsService } from './antifraud-facts.service.js';
import { RepoChecksService } from './repo-checks.service.js';
import { RepoLinkRepository } from './repo-link.repository.js';

const NO_REPOSITORY = 'NO_REPOSITORY';

/** What other modules may ask of github (architecture 3.7). */
@Injectable()
export class GithubFacade implements GithubApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(RepoChecksService) private readonly checks: RepoChecksService,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(AntifraudFactsService) private readonly antifraud: AntifraudFactsService,
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
    if (link === undefined) {
      return { ok: false, reasons: [NO_REPOSITORY], checkedAt: this.clock.now() };
    }
    return (await this.checks.exists(link)).result;
  }

  checkRepositoryFinal(teamId: string): Promise<RepoFinalResult> {
    return this.checks.final(teamId);
  }

  getCrossReviewedPullCount(teamId: string): Promise<number> {
    return this.checks.crossReviewedPulls(teamId);
  }

  getCiState(teamId: string): Promise<'success' | 'none' | null> {
    return this.checks.ciState(teamId);
  }

  getAccountEligibility(userId: string): Promise<AccountEligibility> {
    return this.checks.accountEligibility(userId);
  }

  getAccountChecks(userIds: string[]): Promise<Map<string, AccountCheckView>> {
    return this.antifraud.accountChecks(userIds);
  }

  getPullRequestStats(teamId: string): Promise<PullRequestStats> {
    return this.antifraud.pullRequestStats(teamId);
  }

  getRepositoryFacts(teamId: string): Promise<RepositoryFacts | null> {
    return this.antifraud.repositoryFacts(teamId);
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
