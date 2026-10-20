import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { ParticipationService } from '../services/participation.service.js';
import { StageTransitionService } from '../services/stage-transition.service.js';

/** transitionStage (FR-WORK-10) and confirmParticipation (FR-WORK-11). */
@Controller('v1/teams/:teamId')
export class StageTransitionController {
  constructor(
    @Inject(StageTransitionService) private readonly stages: StageTransitionService,
    @Inject(ParticipationService) private readonly participation: ParticipationService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post('stage-transitions')
  @Authz('transitionStage')
  transitionStage(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'transitionStage'>,
  ): Promise<Ok<'transitionStage'>> {
    return this.stages.transition(requireUserId(this.cls), teamId, body);
  }

  @Post('participation-confirmations')
  @Authz('confirmParticipation')
  confirmParticipation(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'confirmParticipation'>,
  ): Promise<Ok<'confirmParticipation'>> {
    return this.participation.confirm(requireUserId(this.cls), teamId, body);
  }
}
