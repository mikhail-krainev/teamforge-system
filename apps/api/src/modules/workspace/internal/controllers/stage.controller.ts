import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Ok } from 'shared';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { RouteQueryService } from '../services/route-query.service.js';

/** The route of a project: stages with dates and the checklist of a stage (FR-WORK-01, -02, -12). */
@Controller('v1/teams/:teamId/stages')
export class StageController {
  constructor(@Inject(RouteQueryService) private readonly route: RouteQueryService) {}

  @Get()
  @Authz('listStages')
  listStages(@Param('teamId') teamId: string): Promise<Ok<'listStages'>> {
    return this.route.listStages(teamId);
  }

  @Get(':ordinal/checklist')
  @Authz('getStageChecklist')
  getStageChecklist(
    @Param('teamId') teamId: string,
    @Param('ordinal') ordinal: string,
  ): Promise<Ok<'getStageChecklist'>> {
    return this.route.getStageChecklist(teamId, Number(ordinal));
  }
}
