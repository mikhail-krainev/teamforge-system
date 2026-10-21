import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { ReviewAuthorshipRepository } from './review-authorship.repository.js';
import { ReviewEligibilityRepository } from './review-eligibility.repository.js';
import { ReviewRepository } from './review.repository.js';

/** Body of `createPeerReview` after schema validation. */
export interface ReviewCreateInput {
  subjectUserId: string;
  text: string;
}

export interface ReviewSentDto {
  subjectUserId: string;
  status: 'sent';
}

export interface ReviewSentListDto {
  items: ReviewSentDto[];
  windowClosesAt: string;
}

const notFound = (): DomainError => new DomainError('NOT_FOUND', 404);

/**
 * Writing a review and the list of the reviews I sent (FR-PROF-08, SEC-04). Nothing here writes an
 * outbox event, a notification or a log line about the text or the subject.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(ReviewEligibilityRepository) private readonly eligibility: ReviewEligibilityRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(ReviewAuthorshipRepository) private readonly authorship: ReviewAuthorshipRepository,
  ) {}

  /**
   * One transaction: the text, then the pair of the author and the subject; a second review of the pair
   * finds the pair taken (`peer_review_pair_uq` decides a race), and the whole attempt rolls back.
   */
  create(authorUserId: string, teamId: string, input: ReviewCreateInput): Promise<ReviewSentDto> {
    return this.tx.run(async () => {
      const rows = await this.eligibility.forShare(teamId, [authorUserId, input.subjectUserId]);
      const mine = rows.find((row) => row.userId === authorUserId);
      if (mine === undefined) throw notFound();
      if (input.subjectUserId === authorUserId) {
        throw new DomainError('VALIDATION_FAILED', 422, {
          errors: [
            {
              pointer: '/subjectUserId',
              code: 'self_review',
              message: 'A review is about a colleague',
            },
          ],
        });
      }
      if (!rows.some((row) => row.userId === input.subjectUserId)) throw notFound();
      if (this.clock.now().getTime() > mine.windowUntil.getTime()) {
        throw new DomainError('REVIEW_WINDOW_CLOSED', 409);
      }
      const id = randomUUID();
      await this.reviews.insertPending({
        id,
        teamId,
        subjectUserId: input.subjectUserId,
        text: input.text,
        sortKey: randomInt(0, 2 ** 31 - 1),
      });
      const added = await this.authorship.insertIfAbsent({
        reviewId: id,
        teamId,
        authorUserId,
        subjectUserId: input.subjectUserId,
      });
      if (!added) throw new DomainError('REVIEW_EXISTS', 409);
      return { subjectUserId: input.subjectUserId, status: 'sent' as const };
    });
  }

  /** The fact of sending only, with the end of my window; never the text. */
  async listSent(authorUserId: string, teamId: string): Promise<ReviewSentListDto> {
    const mine = await this.eligibility.find(teamId, authorUserId);
    if (mine === undefined) throw notFound();
    const subjects = await this.authorship.subjectsOf(teamId, authorUserId);
    return {
      items: subjects.map((subjectUserId) => ({ subjectUserId, status: 'sent' as const })),
      windowClosesAt: mine.windowUntil.toISOString(),
    };
  }
}
