import { Controller, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { StageTransitionService } from '../services/stage-transition.service.js';

/** transitionStage (FR-WORK-10); the entry gate only, see `StageTransitionService`. */
@Controller('v1/teams/:teamId/stage-transitions')
export class StageTransitionController {
  constructor(
    @Inject(StageTransitionService) private readonly stages: StageTransitionService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post()
  @Authz('transitionStage')
  transitionStage(@Param('teamId') teamId: string): Promise<Ok<'transitionStage'>> {
    return this.stages.transition(requireUserId(this.cls), teamId);
  }
}
