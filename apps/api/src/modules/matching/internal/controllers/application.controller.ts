import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { ApplicationService } from '../services/application.service.js';

/** The search queue application of the signed-in user (FR-MATCH-03, FR-MATCH-04, FR-MATCH-10). */
@Controller('v1/me/search-application')
export class ApplicationController {
  constructor(
    @Inject(ApplicationService) private readonly applications: ApplicationService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get()
  @Authz('getMySearchApplication')
  getMySearchApplication(): Promise<Ok<'getMySearchApplication'>> {
    return this.applications.getMine(requireUserId(this.cls));
  }

  @Post()
  @Authz('createSearchApplication')
  createSearchApplication(
    @Body() body: BodyOf<'createSearchApplication'>,
  ): Promise<Ok<'createSearchApplication'>> {
    return this.applications.create(requireUserId(this.cls), body);
  }

  @Put()
  @Authz('updateSearchApplication')
  updateSearchApplication(
    @Body() body: BodyOf<'updateSearchApplication'>,
  ): Promise<Ok<'updateSearchApplication'>> {
    return this.applications.update(requireUserId(this.cls), body);
  }

  @Delete()
  @HttpCode(204)
  @Authz('cancelSearchApplication')
  async cancelSearchApplication(): Promise<void> {
    await this.applications.cancel(requireUserId(this.cls));
  }
}
