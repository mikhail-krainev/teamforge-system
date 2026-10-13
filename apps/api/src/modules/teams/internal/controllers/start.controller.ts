import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { StartService } from '../services/start.service.js';

/** startProject (FR-TEAM-10). */
@Controller('v1/teams/:teamId')
export class StartController {
  constructor(
    @Inject(StartService) private readonly starts: StartService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post('start')
  @HttpCode(200)
  @Authz('startProject')
  start(@Param('teamId') teamId: string): Promise<Ok<'startProject'>> {
    return this.starts.start(requireUserId(this.cls), teamId);
  }
}
