import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { COMPLETED_PROJECTS_PORT, type CompletedProjectsPort } from '../../public.js';
import { EligibilityService } from './eligibility.service.js';
import { ReviewEligibilityRepository } from './review-eligibility.repository.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A completion younger than this is left to its event. */
export const SCAN_GRACE_MS = 10 * 60_000;
/** The scanner looks back this far: a window is 14 days, so an older completion has nothing left to repair. */
export const SCAN_LOOKBACK_MS = 30 * DAY_MS;
const PAGE = 100;

/**
 * `review-eligibility-scan` (hourly, architecture 5.3, 10.1): the safety net for a lost or dead
 * `workspace.project_completed`. Completions of the last 30 days older than 10 minutes that have no
 * `review_eligibility` row go through the same code as the event; teams that have rows are left alone.
 */
@Injectable()
export class ReviewEligibilityScan implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(ReviewEligibilityRepository) private readonly eligibility: ReviewEligibilityRepository,
    @Inject(EligibilityService) private readonly service: EligibilityService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Optional() @Inject(COMPLETED_PROJECTS_PORT) private readonly completed?: CompletedProjectsPort,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'review-eligibility-scan',
      everyMs: HOUR_MS,
      run: () => this.scan(),
    });
  }

  /** Returns the number of teams repaired. */
  async scan(): Promise<number> {
    if (this.completed === undefined) return 0;
    const now = this.clock.now().getTime();
    const since = new Date(now - SCAN_LOOKBACK_MS);
    const youngest = now - SCAN_GRACE_MS;
    let after: { completedAt: Date; teamId: string } | undefined;
    let repaired = 0;
    for (;;) {
      const page = await this.completed.listCompletedSince(
        since,
        after === undefined ? { limit: PAGE } : { limit: PAGE, after },
      );
      const old = page.filter((p) => p.completedAt.getTime() <= youngest);
      const known = await this.tx.run(() =>
        this.eligibility.teamsWithRows(old.map((p) => p.teamId)),
      );
      for (const project of old.filter((p) => !known.has(p.teamId))) {
        await this.tx.run(() => this.service.record(project));
        repaired += 1;
        this.logger.warn(
          { teamId: project.teamId },
          'review-eligibility-scan repaired a completion',
        );
      }
      const last = page.at(-1);
      if (last === undefined || page.length < PAGE || old.length < page.length) return repaired;
      after = { completedAt: last.completedAt, teamId: last.teamId };
    }
  }
}
