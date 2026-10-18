import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { RepositoryReader } from '../client/repository-reader.js';
import {
  type AccountCheckRow,
  type ActiveLink,
  SyncStateRepository,
} from '../repositories/sync-state.repository.js';
import { RepoChecksService } from '../services/repo-checks.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An account without a public repository and without public activity is looked at again after a day:
 * activity can appear. Any other account is final for FR-GH-09 apart from its age, which only grows.
 */
function needsLook(row: AccountCheckRow | undefined, now: Date): boolean {
  if (row === undefined) return true;
  const quiet = row.publicRepos <= 0 && !row.hasPublicActivity;
  return quiet && now.getTime() - row.checkedAt.getTime() >= DAY_MS;
}

/**
 * `account_check` (FR-GH-09): the creation date, the public repositories and the public activity of the GitHub
 * account of every member of a team that has a repository. The verdict (30 days old, something public) is
 * a pure function of the row (`domain/account-rules.ts`), read when the credit is decided (`pending_account`).
 */
@Injectable()
export class AccountSyncService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RepositoryReader) private readonly reader: RepositoryReader,
    @Inject(SyncStateRepository) private readonly state: SyncStateRepository,
    @Inject(RepoChecksService) private readonly checks: RepoChecksService,
  ) {}

  /** Returns the number of accounts looked at. Throws `GithubError` when GitHub cannot answer. */
  async syncTeamAccounts(link: ActiveLink): Promise<number> {
    const now = this.clock.now();
    const githubIds = (await this.checks.memberGithubIds(link.teamId)).map(([, id]) => id);
    const stored = new Map(
      (await this.state.accountChecks(githubIds)).map((row) => [row.githubUserId, row]),
    );
    let looked = 0;
    for (const githubUserId of new Set(githubIds)) {
      if (!needsLook(stored.get(githubUserId), now)) continue;
      const account = await this.reader.getAccount(link.installationId, githubUserId);
      if (account === null) continue;
      const hasPublicActivity = await this.reader.hasPublicActivity(
        link.installationId,
        account.login,
      );
      await this.state.saveAccountCheck({
        githubUserId,
        accountCreatedAt: new Date(account.created_at),
        publicRepos: account.public_repos,
        hasPublicActivity,
        checkedAt: now,
      });
      looked += 1;
    }
    return looked;
  }
}
