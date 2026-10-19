import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { GITHUB_API, type GithubApi } from '../../../github/public.js';
import { TEAMS_API, type TeamLockView, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import {
  type CheckResultFact,
  type CompletionFacts,
  completionUnmet,
  overdueDaysOf,
} from '../domain/completion-rules.js';
import {
  buildSnapshot,
  COOLING_MS,
  type CompletionSnapshot,
  snapshotView,
} from '../domain/completion-snapshot.js';
import {
  CompletionRepository,
  type ProjectCompletionRow,
} from '../repositories/completion.repository.js';
import { RouteRepository } from '../repositories/route.repository.js';
import { assertCompletable } from './completion-gate.js';

type CompletionDto = Ok<'completeProject'>;

export function toCompletionDto(row: ProjectCompletionRow): CompletionDto {
  return {
    teamId: row.teamId,
    completedAt: row.completedAt.toISOString(),
    plannedEndAt: row.plannedEndAt.toISOString(),
    overdueDays: row.overdueDays,
    onTime: row.overdueDays === 0,
    credit: {
      status: 'cooling',
      coolingUntil: new Date(row.completedAt.getTime() + COOLING_MS).toISOString(),
    },
    snapshot: snapshotView(row.snapshot as CompletionSnapshot),
  };
}

/**
 * completeProject (T6, FR-WORK-13, CC-13, architecture 11.4): lock #4 `team FOR NO KEY UPDATE`, then every
 * condition is read under it. The transition of a stage, the write of a link, the change of a role of a
 * contribution and the unlinking of the repository all take #4 too, so the snapshot sees each of them
 * wholly before or wholly after. `project_completion.team_id` is the primary key: one row per project.
 */
@Injectable()
export class CompletionService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Inject(RouteRepository) private readonly route: RouteRepository,
  ) {}

  complete(leadId: string, teamId: string): Promise<CompletionDto> {
    return this.tx.run(() => this.completeInTx(leadId, teamId));
  }

  async get(teamId: string): Promise<CompletionDto> {
    const row = await this.tx.run(() => this.completions.findCompletion(teamId));
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    return toCompletionDto(row);
  }

  private async completeInTx(leadId: string, teamId: string): Promise<CompletionDto> {
    const team = await this.teams.lockTeam(teamId, 'update');
    if (team.leadUserId !== leadId) throw new DomainError('NOT_TEAM_LEAD', 403);
    assertCompletable(team.status);
    const now = this.clock.now();
    const stages = await this.route.listStages(teamId);
    const roster = await this.teams.getCompletionRosterSnapshot(teamId);
    const contributions = await this.completions.listContributions(teamId);
    const repositoryId = await this.activeRepositoryId(teamId);
    const unmet = completionUnmet({
      now,
      stages,
      memberCount: roster.members.length,
      contributions,
      check: await this.latestCheck(teamId),
      releaseUrl: team.releaseUrl,
      repositoryId,
      releaseAddressHeld: await this.releaseAddressHeld(team),
    });
    if (unmet.length > 0) throw new DomainError('COMPLETION_BLOCKED', 409, { unmet });

    const plannedEndAt = team.plannedEndAt ?? now;
    const overdueDays = overdueDaysOf(plannedEndAt, now);
    const snapshot = buildSnapshot({
      teamId,
      completedAt: now,
      startedAt: team.startedAt,
      plannedEndAt,
      overdueDays,
      productType: team.productType,
      releaseUrl: team.releaseUrl,
      repositoryId,
      roster,
      stages,
      contributions: contributions.filter((c) => c.active),
      participationConfirms: await this.completions.listConfirmations(teamId),
    });
    const row: ProjectCompletionRow = {
      teamId,
      completedAt: now,
      plannedEndAt,
      overdueDays,
      snapshot,
      completedBy: leadId,
    };
    await this.close(team, row, snapshot);
    return toCompletionDto(row);
  }

  /** The writes of T6, after every condition is met: the record, the statuses, the locked labels, the event. */
  private async close(
    team: TeamLockView,
    row: ProjectCompletionRow,
    snapshot: CompletionSnapshot,
  ): Promise<void> {
    await this.completions.insertCompletion(row);
    await this.teams.markCompleted(row.teamId, row.completedAt);
    await this.github.markRepositoryCompleted(row.teamId);
    await this.completions.lockRoles(row.teamId);
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'project_completed',
      aggregateId: row.teamId,
      payload: {
        teamId: row.teamId,
        teamName: team.name,
        completedAt: row.completedAt.toISOString(),
        memberUserIds: snapshot.roster.members.map((m) => m.userId),
      },
    });
  }

  /** The repository that holds the team now, if its link is active. */
  private async activeRepositoryId(teamId: string): Promise<number | null> {
    const link = await this.github.getRepoLink(teamId);
    return link?.status === 'active' ? link.repositoryId : null;
  }

  /** The latest check that has a verdict, with the results as the rules read them. */
  private async latestCheck(teamId: string): Promise<CompletionFacts['check']> {
    const row = await this.completions.latestDoneCheck(teamId);
    if (row === undefined) return null;
    return { validUntil: row.validUntil, results: row.results as CheckResultFact[] };
  }

  /**
   * AF-02: another project already holds this release address. The teams are found by the normalized
   * address (an equality lookup); only those with a record of completion count. Lock order: #4 `team`,
   * then the advisory lock of the address (see `LockService.lockReleaseAddress`).
   */
  private async releaseAddressHeld(team: TeamLockView): Promise<boolean> {
    if (team.releaseKey === null) return false;
    // Two projects with this address complete one after the other: the second sees the first (CC-13).
    await this.locks.lockReleaseAddress(team.releaseKey);
    const holders = await this.teams.listCompletedTeamsByReleaseKey(team.releaseKey, team.teamId);
    return (await this.completions.completedTeamIds(holders)).size > 0;
  }
}
