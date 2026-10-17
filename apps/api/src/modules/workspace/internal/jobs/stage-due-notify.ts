import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { STAGE_DUE_SOON_MS, stageDuePhase } from '../domain/transition-rules.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { TransitionRepository } from '../repositories/transition.repository.js';

const SCAN_EVERY_MS = 15 * 60_000;
const SCAN_BATCH = 200;

/**
 * `stage-due-notify` (timers, architecture 8.3, FR-WORK-19): a day before the due date of the open
 * stage and again when it is past, every member hears about it once (`dedupe_key` per stage and
 * phase). Stage deadlines do not run while the team is suspended (FR-WORK-18): such a team is
 * skipped and gets its notice after it works again. Lateness is only a warning (FR-WORK-12).
 * It does not queue per-stage jobs, so there is nothing to lose in Redis; running it twice in a
 * row creates nothing new.
 */
@Injectable()
export class StageDueNotify implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(TransitionRepository) private readonly transitions: TransitionRepository,
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'stage-due-notify',
      everyMs: SCAN_EVERY_MS,
      run: () => this.scan(),
    });
  }

  /** Returns the number of notifications created. */
  async scan(): Promise<number> {
    const now = this.clock.now();
    const stages = await this.tx.run(() =>
      this.transitions.dueBefore(new Date(now.getTime() + STAGE_DUE_SOON_MS), SCAN_BATCH),
    );
    let created = 0;
    for (const stage of stages) {
      try {
        created += await this.tx.run(() => this.notify(stage, now));
      } catch (error) {
        this.logger.error({ err: error }, `stage-due-notify failed for stage ${stage.id}`);
      }
    }
    return created;
  }

  private async notify(
    stage: { id: string; teamId: string; ordinal: number; dueAt: Date | null },
    now: Date,
  ): Promise<number> {
    const team = await this.teams.getTeamView(stage.teamId);
    if (team === null || stage.dueAt === null) return 0;
    const phase = stageDuePhase(stage.dueAt, now, team.status);
    if (phase === null) return 0;
    const roster = await this.teams.getRoster(stage.teamId);
    const rows = await this.notifications.insertNew(
      roster.map((m) => ({
        id: uuidv7(),
        userId: m.userId,
        type: 'stage_due',
        payload: { teamId: stage.teamId, stageOrdinal: stage.ordinal, phase },
        dedupeKey: `stage_due:${stage.id}:${phase}`,
        createdAt: now,
        readAt: null,
      })),
    );
    await this.outbox.publishMany(
      rows.map((row) => ({
        module: WORKSPACE_MODULE,
        type: 'notification_created',
        aggregateId: row.id,
        payload: { userId: row.userId, notificationId: row.id },
      })),
    );
    return rows.length;
  }
}
