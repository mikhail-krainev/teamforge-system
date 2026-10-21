import { Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import { AvailableRepositoriesService } from './available-repositories.service.js';
import { InstallationSessionService } from './installation-session.service.js';
import { redirectTarget } from './setup-redirect.js';
import { SetupCallbackService, type SetupCallbackQuery } from './setup-callback.service.js';

/** createInstallationSession, githubSetupCallback, listAvailableRepositories (FR-GH-01, SEC-02). */
@Controller('v1')
export class InstallationController {
  constructor(
    @Inject(InstallationSessionService) private readonly sessions: InstallationSessionService,
    @Inject(SetupCallbackService) private readonly callback: SetupCallbackService,
    @Inject(AvailableRepositoriesService) private readonly available: AvailableRepositoriesService,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('teams/:teamId/github/installation-sessions')
  @Authz('createInstallationSession')
  createInstallationSession(
    @Param('teamId') teamId: string,
  ): Promise<Ok<'createInstallationSession'>> {
    return this.sessions.create(requireUserId(this.cls), teamId);
  }

  /** Callback URL of the App: GitHub sends the browser here, the answer is always a redirect to the web. */
  @Get('github/setup')
  @Authz('githubSetupCallback')
  @NoIdempotency()
  async githubSetupCallback(
    @Query() query: SetupCallbackQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const outcome = await this.callback.handle(requireUserId(this.cls), query);
    await reply
      .header('cache-control', 'no-store')
      .redirect(redirectTarget(this.config.APP_ORIGIN, outcome), 302);
  }

  @Get('teams/:teamId/github/available-repositories')
  @Authz('listAvailableRepositories')
  listAvailableRepositories(
    @Param('teamId') teamId: string,
    @Query() query: { installationId: number; cursor?: string; limit?: number },
  ): Promise<Ok<'listAvailableRepositories'>> {
    return this.available.list(requireUserId(this.cls), teamId, query);
  }
}
