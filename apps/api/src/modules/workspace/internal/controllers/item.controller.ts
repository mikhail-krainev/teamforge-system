import { Body, Controller, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { FallbackService } from '../services/fallback.service.js';
import { ItemAssignService } from '../services/item-assign.service.js';
import { ItemService } from '../services/item.service.js';
import { ReviewService } from '../services/review.service.js';

/** updateChecklistItem, assignChecklistItem, revertFallback, submitReview, acceptReviewRisk (FR-WORK-02..09, CC-7). */
@Controller('v1/teams/:teamId/checklist-items')
export class ItemController {
  constructor(
    @Inject(ItemService) private readonly items: ItemService,
    @Inject(ItemAssignService) private readonly assignment: ItemAssignService,
    @Inject(FallbackService) private readonly fallback: FallbackService,
    @Inject(ReviewService) private readonly review: ReviewService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Patch(':itemId')
  @Authz('updateChecklistItem')
  updateChecklistItem(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Body() body: BodyOf<'updateChecklistItem'>,
  ): Promise<Ok<'updateChecklistItem'>> {
    return this.items.update(requireUserId(this.cls), teamId, itemId, body);
  }

  @Put(':itemId/assignee')
  @Authz('assignChecklistItem')
  assignChecklistItem(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Body() body: BodyOf<'assignChecklistItem'>,
  ): Promise<Ok<'assignChecklistItem'>> {
    return this.assignment.assign(requireUserId(this.cls), teamId, itemId, body);
  }

  @Post(':itemId/fallback-reverts')
  @HttpCode(200)
  @Authz('revertFallback')
  revertFallback(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Body() body: BodyOf<'revertFallback'>,
  ): Promise<Ok<'revertFallback'>> {
    return this.fallback.revert(requireUserId(this.cls), teamId, itemId, body);
  }

  @Put(':itemId/review')
  @Authz('submitReview')
  submitReview(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Body() body: BodyOf<'submitReview'>,
  ): Promise<Ok<'submitReview'>> {
    return this.review.submit(requireUserId(this.cls), teamId, itemId, body);
  }

  @Post(':itemId/review/risk-acceptances')
  @HttpCode(200)
  @Authz('acceptReviewRisk')
  acceptReviewRisk(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Body() body: BodyOf<'acceptReviewRisk'>,
  ): Promise<Ok<'acceptReviewRisk'>> {
    return this.review.acceptRisk(requireUserId(this.cls), teamId, itemId, body);
  }
}
