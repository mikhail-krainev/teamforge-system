import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { CompletionCheckService } from '../services/completion-check.service.js';
import { CompletionService } from '../services/completion.service.js';

/** The check of readiness, the completion and its results (FR-WORK-13..15; architecture 11.4). */
@Controller('v1/teams/:teamId')
export class CompletionController {
  constructor(
    @Inject(CompletionCheckService) private readonly checks: CompletionCheckService,
    @Inject(CompletionService) private readonly completion: CompletionService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post('completion-checks')
  @HttpCode(202)
  @Authz('requestCompletionCheck')
  requestCompletionCheck(@Param('teamId') teamId: string): Promise<Ok<'requestCompletionCheck'>> {
    return this.checks.request(requireUserId(this.cls), teamId);
  }

  @Get('completion-checks/latest')
  @Authz('getLatestCompletionCheck')
  getLatestCompletionCheck(
    @Param('teamId') teamId: string,
  ): Promise<Ok<'getLatestCompletionCheck'>> {
    return this.checks.latest(teamId);
  }

  @Post('completion')
  @Authz('completeProject')
  completeProject(@Param('teamId') teamId: string): Promise<Ok<'completeProject'>> {
    return this.completion.complete(requireUserId(this.cls), teamId);
  }

  @Get('completion')
  @Authz('getCompletion')
  getCompletion(@Param('teamId') teamId: string): Promise<Ok<'getCompletion'>> {
    return this.completion.get(teamId);
  }
}
