import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { DisputeService } from '../admin/dispute.service.js';
import { RewardsReadService } from '../read/rewards-read.service.js';

/** The catalog, the awards and counters of a person, the credit of a project and the dispute (FR-REW-04..06, FR-REW-11). */
@Controller('v1')
export class RewardsController {
  constructor(
    @Inject(RewardsReadService) private readonly reads: RewardsReadService,
    @Inject(DisputeService) private readonly disputes: DisputeService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('badges')
  @Authz('listBadges')
  async listBadges(): Promise<Ok<'listBadges'>> {
    const rows = await this.reads.catalog();
    return {
      items: rows.map((b) => ({
        code: b.code,
        name: b.name,
        series: b.series as Ok<'listBadges'>['items'][number]['series'],
        step: b.step,
        scope: b.scope as 'individual' | 'team',
        available: b.available,
      })),
    };
  }

  @Get('users/:userId/awards')
  @Authz('listUserAwards')
  async listUserAwards(@Param('userId') userId: string): Promise<Ok<'listUserAwards'>> {
    await this.reads.assertUserExists(userId);
    const awards = await this.reads.awardsOf(userId);
    return { items: awards.map((a) => ({ ...a, awardedAt: a.awardedAt.toISOString() })) };
  }

  @Get('users/:userId/counters')
  @Authz('getUserCounters')
  async getUserCounters(@Param('userId') userId: string): Promise<Ok<'getUserCounters'>> {
    await this.reads.assertUserExists(userId);
    return this.reads.countersOf(userId);
  }

  @Get('teams/:teamId/credit')
  @Authz('getTeamCredit')
  async getTeamCredit(@Param('teamId') teamId: string): Promise<Ok<'getTeamCredit'>> {
    const credit = await this.reads.creditOf(teamId, requireUserId(this.cls));
    if (credit === null) throw new DomainError('NOT_FOUND', 404);
    return { ...credit, coolingUntil: credit.coolingUntil.toISOString() };
  }

  @Post('teams/:teamId/disputes')
  @Authz('createDispute')
  createDispute(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'createDispute'>,
  ): Promise<Ok<'createDispute'>> {
    return this.disputes.create(requireUserId(this.cls), teamId, body.text);
  }
}
