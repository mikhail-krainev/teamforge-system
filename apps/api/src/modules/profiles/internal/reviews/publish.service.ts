import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { InlineDelivery } from '../../../../platform/outbox/inline-delivery.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROFILES_MODULE, REVIEWS_PUBLISHED } from '../../public.js';
import { ReviewEligibilityRepository } from './review-eligibility.repository.js';
import { utcDay } from './review-rules.js';
import { ReviewRepository } from './review.repository.js';

/** What a run did: the number of subjects whose reviews were published and withheld. */
export interface PublishReport {
  teams: number;
  published: number;
  withheld: number;
}

const NOTHING: PublishReport = { teams: 0, published: 0, withheld: 0 };

/**
 * The batch after the window (SEC-04, architecture 5.3): in one transaction per team, a subject with
 * at least two `pending` reviews gets them published on the day the window closed, any other gets them
 * withheld for 30 days. The unit of idempotence is "the `pending` rows of the team after the window": a
 * second or parallel run finds none. The publication and its events are written in one transaction.
 */
@Injectable()
export class ReviewPublishService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(ReviewEligibilityRepository) private readonly eligibility: ReviewEligibilityRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(InlineDelivery) private readonly inline: InlineDelivery,
  ) {}

  /** The timer `review-publish` of one team. A run before the end of the window changes nothing. */
  publishTeam(teamId: string): Promise<PublishReport> {
    return this.tx.run(async () => {
      // Every run of the team starts with the same lock (rows by user id): parallel jobs queue up here.
      const rows = await this.eligibility.lockTeam(teamId);
      const first = rows[0];
      if (first === undefined || first.windowUntil.getTime() > this.clock.now().getTime()) {
        return NOTHING;
      }
      const settled = await this.reviews.settleTeam(teamId, utcDay(first.windowUntil));
      const published = settled.filter((s) => s.status === 'published');
      const eventIds = await this.outbox.publishMany(
        published.map((s) => ({
          module: PROFILES_MODULE,
          type: REVIEWS_PUBLISHED,
          aggregateId: teamId,
          payload: { teamId, teamName: first.teamName, userId: s.subjectUserId },
        })),
      );
      // The notification exists when the job is done, not a moment later (the same transaction).
      await this.inline.deliver(eventIds);
      return {
        teams: settled.length === 0 ? 0 : 1,
        published: published.length,
        withheld: settled.length - published.length,
      };
    });
  }

  /** `run-job review-publish` and the hourly sweep: every team whose window is over and that still has `pending` reviews. */
  async publishDue(): Promise<PublishReport> {
    const teamIds = await this.tx.run(() => this.eligibility.dueTeams(this.clock.now()));
    const total = { ...NOTHING };
    for (const teamId of teamIds) {
      const one = await this.publishTeam(teamId);
      total.teams += one.teams;
      total.published += one.published;
      total.withheld += one.withheld;
    }
    return total;
  }

  /** `review-purge` (daily): the withheld reviews whose day has come are deleted with their authorship rows. */
  purge(): Promise<number> {
    return this.tx.run(() => this.reviews.purgeDue(utcDay(this.clock.now())));
  }
}
