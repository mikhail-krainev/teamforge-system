import { Inject, Injectable } from '@nestjs/common';
import type { Body, Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamLockView, type TeamsApi } from '../../../teams/public.js';
import { GithubError } from '../client/github-error.js';
import { githubUnavailable } from '../installation/github-problems.js';
import { installationNotGranted } from '../installation/available-repositories.service.js';
import { InstallationRepository } from '../installation/installation.repository.js';
import { RepoInspectionService } from './repo-inspection.service.js';
import { RepoLinkRepository, type RepoLinkRow } from './repo-link.repository.js';
import { isOlderThanThirtyDays, rejectionMessage } from './repo-rules.js';

const GITHUB_MODULE_NAME = 'github';

/**
 * FR-WORK-18: a finished project keeps its repository for good, a suspended or voting one is read-only
 * for the lead. Same answers as the workspace writes.
 */
function assertTeamAllowsRepoChange(status: TeamLockView['status']): void {
  if (status === 'completed' || status === 'archived') throw new DomainError('INVALID_STATE', 409);
  if (status === 'suspended' || status === 'voting') {
    throw new DomainError('TEAM_STATUS_BLOCKS_ACTION', 409);
  }
}

/** linkRepository, getRepository, unlinkRepository (FR-GH-01, FR-GH-02, FR-GH-07; CC-9, SEC-02). */
@Injectable()
export class RepoLinkService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(InstallationRepository) private readonly installations: InstallationRepository,
    @Inject(RepoInspectionService) private readonly inspection: RepoInspectionService,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
  ) {}

  /**
   * The caller is the lead (policy). The grant is checked first, so a guessed installation reveals
   * nothing; GitHub is asked with the installation token before the transaction (no lock is held over
   * a network call); then lock #4, the grant and the lead again, and `INSERT repo_link` (CC-9).
   */
  async link(
    userId: string,
    teamId: string,
    body: Body<'linkRepository'>,
  ): Promise<Ok<'linkRepository'>> {
    const { installationId, repositoryId } = body;
    if (!(await this.installations.hasActiveGrant(installationId, teamId, userId))) {
      throw installationNotGranted();
    }
    const inspected = await this.inspectOrFail(installationId, repositoryId);
    if (inspected.repository === null || inspected.rejections.length > 0) {
      throw new DomainError('REPO_REJECTED', 422, {
        errors: inspected.rejections.map((code) => ({
          pointer: '/repositoryId',
          code,
          message: rejectionMessage(code),
        })),
      });
    }
    const { repository } = inspected;
    const now = this.clock.now();
    const created = await this.tx.run(async () => {
      const team = await this.teams.lockTeam(teamId, 'update');
      if (team.leadUserId !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
      assertTeamAllowsRepoChange(team.status);
      // The grant may have been revoked while GitHub was asked.
      if (!(await this.installations.hasActiveGrant(installationId, teamId, userId))) {
        throw installationNotGranted();
      }
      const holding = await this.links.findHolding(teamId, true);
      if (holding !== undefined) {
        // The same repository again is the same answer; another one needs the lead to unlink first.
        if (holding.repositoryId === repositoryId) return { row: holding, team, isNew: false };
        throw new DomainError('INVALID_STATE', 409);
      }
      const row = await this.links.insert({
        teamId,
        repositoryId,
        installationId,
        fullName: repository.full_name,
        isPrivate: repository.private,
        isFork: repository.fork,
        repoCreatedAt: new Date(repository.created_at),
        linkedBy: userId,
        linkedAt: now,
      });
      await this.outbox.publish({
        module: GITHUB_MODULE_NAME,
        type: 'repo_linked',
        aggregateId: row.id,
        payload: { teamId, repositoryId, installationId, fullName: row.fullName },
      });
      return { row, team, isNew: true };
    });
    return this.dto(created.row, created.team.startedAt);
  }

  /** Any member (policy) reads the repository of the team; 404 when there is none. */
  async get(teamId: string): Promise<Ok<'getRepository'>> {
    const row = await this.links.findHolding(teamId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    const team = await this.teams.getTeamView(teamId);
    return this.dto(row, team?.startedAt ?? null);
  }

  /** FR-GH-07: the lead (policy) frees the repository; the row stays as history. */
  async unlink(userId: string, teamId: string): Promise<void> {
    const now = this.clock.now();
    await this.tx.run(async () => {
      const team = await this.teams.lockTeam(teamId, 'update');
      if (team.leadUserId !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
      const holding = await this.links.findHolding(teamId, true);
      if (holding === undefined) throw new DomainError('NOT_FOUND', 404);
      assertTeamAllowsRepoChange(team.status);
      if (holding.status !== 'active') throw new DomainError('INVALID_STATE', 409);
      await this.links.markUnlinked(holding.id, now, 'lead');
      await this.outbox.publish({
        module: GITHUB_MODULE_NAME,
        type: 'repo_unlinked',
        aggregateId: holding.id,
        payload: { teamId, repositoryId: holding.repositoryId, reason: 'lead' },
      });
    });
  }

  private async inspectOrFail(installationId: number, repositoryId: number) {
    try {
      return await this.inspection.inspect(installationId, repositoryId);
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      // Gone on GitHub: the grant outlived the installation until the webhook revokes it (S6-05).
      if (error.kind === 'installation_gone' || error.kind === 'installation_suspended') {
        throw new DomainError('INSTALLATION_INVALID', 404);
      }
      throw githubUnavailable(error);
    }
  }

  /** AF-03 counts from the start of the project, or from the binding while the team is still forming. */
  private dto(row: RepoLinkRow, projectStartedAt: Date | null): Ok<'getRepository'> {
    const older = isOlderThanThirtyDays(row.repoCreatedAt, projectStartedAt ?? row.linkedAt);
    return {
      repositoryId: row.repositoryId,
      fullName: row.fullName,
      installationId: row.installationId,
      status: row.status as 'active' | 'completed' | 'unlinked',
      private: row.isPrivate,
      linkedAt: row.linkedAt.toISOString(),
      linkedBy: row.linkedBy,
      warnings: older ? ['repo_older_than_30_days'] : [],
    };
  }
}
