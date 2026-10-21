import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import type { CompletedProject } from '../../public.js';
import { ReviewEligibilityRepository } from './review-eligibility.repository.js';
import { REVIEW_PUBLISH_JOB, reviewPublishJobId, windowUntilOf } from './review-rules.js';

/**
 * The right to write reviews (FR-PROF-08, C-27): a row of `review_eligibility` for every participant of a
 * completed project with the end of the window, and the timer that publishes the batch at that moment.
 * The event consumer and the safety-net scanner both end here; a repeated run adds nothing.
 */
@Injectable()
export class EligibilityService {
  constructor(
    @Inject(ReviewEligibilityRepository) private readonly eligibility: ReviewEligibilityRepository,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** Must run in a transaction; a failure to reach Redis is thrown, so the rows are not kept without the timer. */
  async record(project: CompletedProject): Promise<number> {
    const windowUntil = windowUntilOf(project.completedAt);
    const inserted = await this.eligibility.insertMany(
      [...new Set(project.memberUserIds)].map((userId) => ({
        teamId: project.teamId,
        userId,
        teamName: project.teamName,
        windowUntil,
      })),
    );
    await this.queues.add(
      'timers',
      REVIEW_PUBLISH_JOB,
      { teamId: project.teamId },
      {
        jobId: reviewPublishJobId(project.teamId),
        delayMs: Math.max(0, windowUntil.getTime() - this.clock.now().getTime()),
      },
    );
    return inserted;
  }
}
