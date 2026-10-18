import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as ContractBody, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { RepoLinkService } from './repo-link.service.js';

/** linkRepository, getRepository, unlinkRepository (FR-GH-01, FR-GH-02, FR-GH-07). */
@Controller('v1/teams/:teamId/repository')
export class RepoController {
  constructor(
    @Inject(RepoLinkService) private readonly repo: RepoLinkService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Put()
  @Authz('linkRepository')
  @HttpCode(200)
  link(
    @Param('teamId') teamId: string,
    @Body() body: ContractBody<'linkRepository'>,
  ): Promise<Ok<'linkRepository'>> {
    return this.repo.link(requireUserId(this.cls), teamId, body);
  }

  @Get()
  @Authz('getRepository')
  get(@Param('teamId') teamId: string): Promise<Ok<'getRepository'>> {
    return this.repo.get(teamId);
  }

  @Delete()
  @Authz('unlinkRepository')
  @HttpCode(204)
  async unlink(@Param('teamId') teamId: string): Promise<void> {
    await this.repo.unlink(requireUserId(this.cls), teamId);
  }
}
