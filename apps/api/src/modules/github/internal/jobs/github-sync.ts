import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { GithubError } from '../client/github-error.js';
import { RateLimitGate } from '../client/rate-limit-gate.js';
import { type ActiveLink, SyncStateRepository } from '../repositories/sync-state.repository.js';
import { AccountSyncService } from './account-sync.service.js';
import { RepoSyncService } from './repo-sync.service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * `github-sync` (FR-GH-06, C-57): once a day, every active repository is reconciled with GitHub, its
 * repository checks are made and the accounts of its members are looked at. `github-sync-resume` runs
 * every hour and takes only the repositories whose last full run is older than a day: that is how what a
 * limit, a failure of GitHub or a restart cut short is finished, and the repositories drift apart in time.
 *
 * Limits are obeyed, not fought (architecture 7.4): the first answer with `Retry-After` or an exhausted
 * quota pauses all background reads until the time GitHub named (`RateLimitGate`) and ends the run. Any
 * other failure costs one repository its turn, never the run. Both tasks are safe to run twice.
 */
@Injectable()
export class GithubSync implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RateLimitGate) private readonly gate: RateLimitGate,
    @Inject(SyncStateRepository) private readonly state: SyncStateRepository,
    @Inject(RepoSyncService) private readonly repos: RepoSyncService,
    @Inject(AccountSyncService) private readonly accounts: AccountSyncService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'github-sync',
      everyMs: DAY_MS,
      run: () => this.run({ onlyStale: false }),
    });
    this.maintenance.register({
      name: 'github-sync-resume',
      everyMs: HOUR_MS,
      run: () => this.run({ onlyStale: true }),
    });
  }

  /** Returns the number of repositories reconciled. */
  async run(options: { onlyStale: boolean }): Promise<number> {
    const pausedUntil = await this.gate.pausedUntil();
    if (pausedUntil !== null) {
      this.logger.info({ until: pausedUntil.toISOString() }, 'github-sync: paused by a rate limit');
      return 0;
    }
    const links = await this.state.activeLinks();
    let done = 0;
    for (const link of links) {
      if (options.onlyStale && !(await this.isStale(link))) continue;
      try {
        await this.repos.syncRepository(link);
        await this.accounts.syncTeamAccounts(link);
        done += 1;
      } catch (error) {
        if (await this.stopsTheRun(error, link)) return done;
      }
    }
    return done;
  }

  private async isStale(link: ActiveLink): Promise<boolean> {
    const last = (await this.state.state(link.repositoryId))?.lastSyncedAt;
    return last == null || this.clock.now().getTime() - last.getTime() >= DAY_MS;
  }

  /** True after a limit: the pause is recorded and nothing else is read now. */
  private async stopsTheRun(error: unknown, link: ActiveLink): Promise<boolean> {
    if (error instanceof GithubError && error.kind === 'rate_limited') {
      const until = await this.gate.pauseFor(error);
      this.logger.warn({ until: until.toISOString() }, 'github-sync: rate limited, run postponed');
      return true;
    }
    // No URLs, headers or bodies of GitHub in the log: the kind and the status are enough.
    this.logger.warn(
      {
        repository_id: link.repositoryId,
        kind: error instanceof GithubError ? error.kind : 'internal',
        status: error instanceof GithubError ? error.status : undefined,
        err: error instanceof GithubError ? undefined : error,
      },
      'github-sync: repository skipped',
    );
    return false;
  }
}
