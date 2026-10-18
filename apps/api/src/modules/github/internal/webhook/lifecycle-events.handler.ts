import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { GITHUB_MODULE } from '../../public.js';
import { GithubClient, type RepositoryDetail } from '../client/github-client.js';
import { GithubError } from '../client/github-error.js';
import { InstallationRepository } from '../installation/installation.repository.js';
import { RepoLinkRepository, type RepoLinkRow } from '../services/repo-link.repository.js';
import type {
  InstallationEvent,
  InstallationRepositoriesEvent,
  RepositoryEvent,
} from './payload-schemas.js';
import { apply, type DeliveryPlan, type EventIds, IGNORE } from './plan.js';

type UnlinkReason =
  'installation_deleted' | 'repository_removed' | 'repository_deleted' | 'repository_transferred';

/**
 * The events that take something away (FR-GH-07, SEC-06): the installation is removed or suspended, a
 * repository leaves it, is deleted or moves. A signed delivery is not enough for any of them. GitHub is
 * asked first, with the App's own credentials, and a delivery that GitHub does not confirm is ignored.
 * Earlier contributions always stay.
 */
@Injectable()
export class LifecycleEventsHandler {
  constructor(
    @Inject(GithubClient) private readonly client: GithubClient,
    @Inject(InstallationRepository) private readonly installations: InstallationRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async installation(event: InstallationEvent): Promise<DeliveryPlan> {
    const id = event.installation.id;
    const current = await this.client.getAppInstallation(id);
    switch (event.action) {
      case 'deleted':
        if (current !== null) return this.notConfirmed(event.action);
        return apply(async () => {
          const now = this.clock.now();
          await this.installations.revokeGrants(id, now);
          await this.installations.setStatus(id, 'deleted', now);
          return this.unlink(await this.links.findActiveByInstallation(id), 'installation_deleted');
        });
      case 'suspend':
        if (current === null || !current.suspended) return this.notConfirmed(event.action);
        return apply(async () => {
          const now = this.clock.now();
          await this.installations.revokeGrants(id, now);
          await this.installations.setStatus(id, 'suspended', now);
          return [];
        });
      case 'unsuspend':
        if (current === null || current.suspended) return this.notConfirmed(event.action);
        return apply(async () => {
          await this.installations.setStatus(id, 'active', this.clock.now());
          return [];
        });
      default:
        return IGNORE;
    }
  }

  async installationRepositories(event: InstallationRepositoriesEvent): Promise<DeliveryPlan> {
    if (event.action !== 'removed') return IGNORE;
    const installationId = event.installation.id;
    const confirmed: RepoLinkRow[] = [];
    for (const repo of event.repositories_removed) {
      const link = await this.links.findActiveByRepository(repo.id);
      if (link?.installationId !== installationId) continue;
      if ((await this.fetchRepository(installationId, repo.id)) === null) confirmed.push(link);
    }
    if (confirmed.length === 0) return this.notConfirmed(event.action);
    return apply(() => this.unlink(confirmed, 'repository_removed'));
  }

  async repository(event: RepositoryEvent): Promise<DeliveryPlan> {
    const { repository, installation, action } = event;
    const link = await this.links.findActiveByRepository(repository.id);
    if (link?.installationId !== installation.id) return IGNORE;
    switch (action) {
      // The name comes from GitHub now, not from the payload: deliveries are not ordered, and an older
      // rename that arrives late must not bring the old name back.
      case 'renamed':
        return this.refreshName(link, installation.id, repository.id);
      case 'deleted':
        if ((await this.fetchRepository(installation.id, repository.id)) !== null) {
          return this.notConfirmed(action);
        }
        return apply(() => this.unlink([link], 'repository_deleted'));
      case 'transferred': {
        const detail = await this.fetchRepository(installation.id, repository.id);
        if (detail === null) return apply(() => this.unlink([link], 'repository_transferred'));
        return this.rename(link, detail);
      }
      // Archived or made private: the link stays, the final check of the project fails by itself.
      default:
        return apply(() => Promise.resolve([]));
    }
  }

  private async refreshName(
    link: RepoLinkRow,
    installationId: number,
    repositoryId: number,
  ): Promise<DeliveryPlan> {
    const detail = await this.fetchRepository(installationId, repositoryId);
    return detail === null ? this.notConfirmed('renamed') : this.rename(link, detail);
  }

  private rename(link: RepoLinkRow, detail: RepositoryDetail): DeliveryPlan {
    return apply(async () => {
      await this.links.updateFullName(link.id, detail.full_name);
      return [];
    });
  }

  /** The repository as the installation sees it; `null` when it is gone (or the whole installation is). */
  private async fetchRepository(
    installationId: number,
    repositoryId: number,
  ): Promise<RepositoryDetail | null> {
    try {
      return await this.client.getRepository(installationId, repositoryId);
    } catch (error) {
      if (error instanceof GithubError && error.kind === 'installation_gone') return null;
      throw error;
    }
  }

  private notConfirmed(action: string): DeliveryPlan {
    this.logger.warn({ action }, 'webhook not confirmed by GitHub, ignored');
    return IGNORE;
  }

  /** Lock order: teams first (lowest id first), then the links; a concurrent unlink by the lead has finished or waits. */
  private async unlink(candidates: RepoLinkRow[], reason: UnlinkReason): Promise<EventIds> {
    const teamIds = [...new Set(candidates.map((link) => link.teamId))].sort();
    for (const teamId of teamIds) await this.teams.lockTeam(teamId, 'update');
    const now = this.clock.now();
    const ids: EventIds = [];
    for (const candidate of candidates) {
      const link = await this.links.findActiveByRepository(candidate.repositoryId);
      if (link?.id !== candidate.id) continue;
      await this.links.markUnlinked(link.id, now, reason);
      const id = await this.outbox.publish({
        module: GITHUB_MODULE,
        type: 'repo_unlinked',
        aggregateId: link.teamId,
        payload: { teamId: link.teamId, repositoryId: link.repositoryId, reason },
      });
      ids.push(id);
    }
    return ids;
  }
}
