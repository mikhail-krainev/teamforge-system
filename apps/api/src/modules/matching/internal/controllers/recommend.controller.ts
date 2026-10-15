import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { RecommendService, type RecommendQuery } from '../services/recommend.service.js';

/** Recommendations: candidates for a seat (lead) and teams for me (FR-MATCH-01, FR-MATCH-02). */
@Controller('v1')
export class RecommendController {
  constructor(
    @Inject(RecommendService) private readonly recommendations: RecommendService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('teams/:teamId/seats/:seatId/candidates')
  @Authz('listSeatCandidates')
  listSeatCandidates(
    @Param('teamId') teamId: string,
    @Param('seatId') seatId: string,
    @Query() query: RecommendQuery,
  ): Promise<Ok<'listSeatCandidates'>> {
    return this.recommendations.listSeatCandidates(teamId, seatId, query);
  }

  @Get('me/recommended-teams')
  @Authz('listRecommendedTeams')
  listRecommendedTeams(@Query() query: RecommendQuery): Promise<Ok<'listRecommendedTeams'>> {
    return this.recommendations.listRecommendedTeams(requireUserId(this.cls), query);
  }
}
