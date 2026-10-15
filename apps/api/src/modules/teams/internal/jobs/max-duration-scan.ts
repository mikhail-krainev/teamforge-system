import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  MAX_DURATION_REASON,
  MAX_PROJECT_DAYS,
  maxDurationReached,
  transitionError,
} from '../domain/team-status.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { team } from '../schema/teams.js';
import { statusJournalRow } from '../services/start-events.js';
import { teamsEvent } from '../services/team-events.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const MAX_DURATION_BATCH = 200;

interface LockedRow {
  id: string;
  status: string;
  /** Raw lock queries return timestamps as strings or dates, depending on the driver path. */
  started_at: Date | string | null;
  suspended_total_seconds: number;
}

/**
 * `max-duration-scan` (hourly, FR-TEAM-27, C-06): an active project 120 days after its start
 * becomes `suspended` with the reason `max_duration`. The candidates are found without locks (index
 * `team_status_started_idx`); each team is re-checked under lock #4, so a second run, or a vote
 * that opens at the same moment, changes nothing twice.
 */
@Injectable()
export class MaxDurationScan implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'max-duration-scan',
      everyMs: HOUR_MS,
      run: () => this.scan(),
    });
  }

  async scan(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - MAX_PROJECT_DAYS * DAY_MS);
    const candidates = await this.tx.tx
      .select({ id: team.id })
      .from(team)
      .where(and(eq(team.status, 'active'), lte(team.startedAt, cutoff)))
      .orderBy(team.startedAt)
      .limit(MAX_DURATION_BATCH);
    let suspended = 0;
    for (const { id } of candidates) {
      if (await this.tx.run(() => this.suspend(id, now))) suspended += 1;
    }
    if (suspended > 0) this.logger.info({ suspended }, 'projects suspended: max duration');
    return suspended;
  }

  private async suspend(teamId: string, now: Date): Promise<boolean> {
    const raw = await this.locks.lockTeam<LockedRow & Record<string, unknown>>(teamId);
    if (raw === undefined) return false;
    const due = maxDurationReached(
      {
        status: raw.status,
        startedAt: raw.started_at === null ? null : new Date(raw.started_at),
        suspendedTotalSeconds: raw.suspended_total_seconds,
      },
      now,
    );
    if (!due || transitionError(raw.status, 'suspended') !== undefined) return false;
    await this.tx.tx
      .update(team)
      .set({
        status: 'suspended',
        statusReason: MAX_DURATION_REASON,
        suspendedAt: now,
        version: sql`${team.version} + 1`,
        updatedAt: now,
      })
      .where(eq(team.id, teamId));
    const change = { from: 'active', to: 'suspended', reason: MAX_DURATION_REASON };
    await this.events.insertMany([
      statusJournalRow(teamId, 'team_status_changed', null, change, now),
    ]);
    await this.outbox.publishMany([
      teamsEvent('team_status_changed', teamId, { teamId, ...change }),
    ]);
    return true;
  }
}
