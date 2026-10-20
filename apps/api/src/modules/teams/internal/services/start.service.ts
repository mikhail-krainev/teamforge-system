import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import { TEAM_LIFECYCLE_PORT, type TeamLifecyclePort } from '../../public.js';
import { plannedEnd, startError } from '../domain/team-status.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository, type TeamRow } from '../repositories/team.repository.js';
import { statusJournalRow } from './start-events.js';
import type { TeamDto } from './team-dto.js';
import { teamsEvent } from './team-events.js';
import { TeamLeadLock } from './team-lead-lock.js';
import { TeamViewService } from './team-view.service.js';

/** startProject (T4, FR-TEAM-10, CC-13): `forming` -> `active` under lock #4. */
@Injectable()
export class StartService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(TEAM_LIFECYCLE_PORT) private readonly lifecycle: TeamLifecyclePort,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
    @Inject(TeamViewService) private readonly view: TeamViewService,
  ) {}

  async start(userId: string, teamId: string): Promise<TeamDto> {
    const row = await this.teams.find(teamId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    const pinned = { playbookId: row.playbookId, days: await this.pinnedPlaybookDays(row) };
    await this.tx.run(() => this.startInTx(userId, teamId, pinned));
    return this.view.team(teamId, userId);
  }

  /**
   * Reference read before BEGIN (architecture 3.4: no foreign module under a lock). The pinned
   * playbook is immutable once published, so its length is the planned length of the project
   * (FR-WORK-12); an unreadable playbook falls back to the C-06 maximum.
   */
  private async pinnedPlaybookDays(row: TeamRow): Promise<number | null> {
    try {
      return (await this.playbooks.getDefinition(row.playbookId)).totalDays;
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) return null;
      throw error;
    }
  }

  private async startInTx(
    userId: string,
    teamId: string,
    pinned: { playbookId: string; days: number | null },
  ): Promise<void> {
    const locked = await this.leadLock.lock(teamId, userId);
    const refusal = startError(locked.status);
    if (refusal !== undefined) throw new DomainError(refusal, 409);
    const row = await this.teams.find(teamId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    // A forming team can be rebound (a stub moved to a real playbook) between the reference read and the
    // lock. Published playbooks are immutable and take no lock, so the one extra read in the transaction
    // is harmless; a second transaction is not allowed under one Idempotency-Key.
    const playbookDays =
      row.playbookId === pinned.playbookId ? pinned.days : await this.pinnedPlaybookDays(row);
    const now = this.clock.now();
    await this.teams.update(teamId, {
      status: 'active',
      statusReason: null,
      startedAt: now,
      plannedEndAt: plannedEnd(now, playbookDays),
      version: row.version + 1,
      updatedAt: now,
    });
    await this.lifecycle.onProjectStarted({ teamId, playbookId: row.playbookId, startedAt: now });
    await this.events.insertMany([
      statusJournalRow(teamId, 'team_started', userId, { from: 'forming' }, now),
    ]);
    await this.outbox.publishMany([
      teamsEvent('team_started', teamId, { teamId, startedAt: now.toISOString() }),
      teamsEvent('team_status_changed', teamId, {
        teamId,
        from: 'forming',
        to: 'active',
        reason: 'started',
      }),
    ]);
  }
}
