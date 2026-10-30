import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { ReceivedReviewsQuery, type ReceivedReviewsRequest } from './received-reviews.query.js';
import { ReviewService, type ReviewCreateInput } from './review.service.js';

/** createPeerReview, listSentReviews, listReceivedReviews (FR-PROF-08, SEC-04). */
@Controller('v1')
export class ReviewController {
  constructor(
    @Inject(ReviewService) private readonly reviews: ReviewService,
    @Inject(ReceivedReviewsQuery) private readonly received: ReceivedReviewsQuery,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('me/reviews')
  @Authz('listReceivedReviews')
  listReceivedReviews(@Query() query: ReceivedReviewsRequest): Promise<Ok<'listReceivedReviews'>> {
    return this.received.list(requireUserId(this.cls), query);
  }

  @Post('teams/:teamId/reviews')
  @Authz('createPeerReview')
  createPeerReview(
    @Param('teamId') teamId: string,
    @Body() body: ReviewCreateInput,
  ): Promise<Ok<'createPeerReview'>> {
    return this.reviews.create(requireUserId(this.cls), teamId, body);
  }

  @Get('teams/:teamId/reviews/sent')
  @Authz('listSentReviews')
  listSentReviews(@Param('teamId') teamId: string): Promise<Ok<'listSentReviews'>> {
    return this.reviews.listSent(requireUserId(this.cls), teamId);
  }
}
