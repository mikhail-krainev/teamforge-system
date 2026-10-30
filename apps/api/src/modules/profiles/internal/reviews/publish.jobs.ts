import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CliJobs } from '../../../../platform/queues/cli-jobs.js';
import { MaintenanceTasks, TimerHandlers } from '../../../../platform/queues/maintenance-tasks.js';
import { ReviewPublishService } from './publish.service.js';
import { REVIEW_PUBLISH_JOB, parseReviewPublish } from './review-rules.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The entry points of the publication: the timer of a team (`timers` / `review-publish`), the operator
 * and e2e run (`run-job review-publish`, no team: everything that is due), the hourly sweep that repairs
 * a lost timer and the daily purge of withheld reviews.
 */
@Injectable()
export class ReviewPublishJobs implements OnModuleInit {
  constructor(
    @Inject(TimerHandlers) private readonly timers: TimerHandlers,
    @Inject(CliJobs) private readonly cliJobs: CliJobs,
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(ReviewPublishService) private readonly publisher: ReviewPublishService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.timers.register(REVIEW_PUBLISH_JOB, (data) =>
      this.publisher.publishTeam(parseReviewPublish(data)),
    );
    this.cliJobs.register(REVIEW_PUBLISH_JOB, () => this.publisher.publishDue());
    this.maintenance.register({
      name: 'review-publish-sweep',
      everyMs: HOUR_MS,
      run: async () => {
        const report = await this.publisher.publishDue();
        if (report.teams > 0)
          this.logger.warn({ ...report }, 'review-publish-sweep published late');
        return report.teams;
      },
    });
    this.maintenance.register({
      name: 'review-purge',
      everyMs: DAY_MS,
      run: () => this.publisher.purge(),
    });
  }
}
