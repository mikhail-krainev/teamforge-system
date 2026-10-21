import { Inject, Injectable } from '@nestjs/common';
import { RepoLinkRepository } from '../services/repo-link.repository.js';
import { ItemRepository } from './item.repository.js';
import type { ReviewEvent } from './payload-schemas.js';
import { apply, type DeliveryPlan, IGNORE } from './plan.js';

/** `pull_request_review` (FR-GH-05): the last review of every reviewer, which `pr_cross_review` reads. */
@Injectable()
export class ReviewEventsHandler {
  constructor(
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
  ) {}

  async review(event: ReviewEvent, receivedAt: Date): Promise<DeliveryPlan> {
    const { review, repository, installation } = event;
    const link = await this.links.findActiveByRepository(repository.id);
    if (link === undefined || link.installationId !== installation.id) return IGNORE;
    if (review.user === null) return IGNORE;
    const reviewerGithubId = review.user.id;
    return apply(async () => {
      await this.items.upsertReview({
        repositoryId: repository.id,
        prNumber: event.pull_request.number,
        reviewerGithubId,
        state: review.state.toLowerCase(),
        submittedAt: review.submitted_at ? new Date(review.submitted_at) : receivedAt,
      });
      return [];
    });
  }
}
