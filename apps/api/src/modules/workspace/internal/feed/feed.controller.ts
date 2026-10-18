import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { RelabelService } from '../contribution/relabel.service.js';
import { FeedService, type FeedQuery } from './feed.service.js';

/** getTeamFeed, getContributionSummary, relabelContribution (FR-WORK-16, FR-WORK-17). */
@Controller('v1/teams/:teamId')
export class FeedController {
  constructor(
    @Inject(FeedService) private readonly feed: FeedService,
    @Inject(RelabelService) private readonly relabeling: RelabelService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('feed')
  @Authz('getTeamFeed')
  getTeamFeed(
    @Param('teamId') teamId: string,
    @Query() query: FeedQuery,
  ): Promise<Ok<'getTeamFeed'>> {
    return this.feed.list(teamId, query);
  }

  @Get('contributions/summary')
  @Authz('getContributionSummary')
  getContributionSummary(@Param('teamId') teamId: string): Promise<Ok<'getContributionSummary'>> {
    return this.feed.summary(teamId);
  }

  @Patch('contributions/:contributionId')
  @Authz('relabelContribution')
  relabelContribution(
    @Param('teamId') teamId: string,
    @Param('contributionId') contributionId: string,
    @Body() body: BodyOf<'relabelContribution'>,
  ): Promise<Ok<'relabelContribution'>> {
    return this.relabeling.relabel(requireUserId(this.cls), teamId, contributionId, body);
  }
}
