import { Controller, Delete, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { TrialService } from '../services/trial.service.js';

/** excludeTrialMember and confirmTrial (FR-TEAM-22, FR-TEAM-24). */
@Controller('v1/teams/:teamId/members/:userId')
export class TrialController {
  constructor(
    @Inject(TrialService) private readonly trials: TrialService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Delete()
  @HttpCode(204)
  @Authz('excludeTrialMember')
  async excludeTrialMember(
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.trials.exclude(requireUserId(this.cls), teamId, userId);
  }

  @Post('trial-confirmation')
  @HttpCode(200)
  @Authz('confirmTrial')
  confirmTrial(
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
  ): Promise<Ok<'confirmTrial'>> {
    return this.trials.confirm(requireUserId(this.cls), teamId, userId);
  }
}
