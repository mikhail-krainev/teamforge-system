import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { DemandService } from './demand.service.js';

/** Query of `getRoleDemand`: `roles` arrives as an array after validation (a lone key is wrapped). */
interface DemandQuery {
  roles?: string[] | string;
}

/** The demand showcase, readable by any signed-in user (FR-MATCH-09, FR-PROF-07). */
@Controller('v1/demand')
export class DemandController {
  constructor(
    @Inject(DemandService) private readonly demand: DemandService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get()
  @Authz('getRoleDemand')
  async getRoleDemand(@Query() query: DemandQuery): Promise<Ok<'getRoleDemand'>> {
    const asked = query.roles === undefined ? [] : [query.roles].flat();
    const roles = await this.demand.rolesOrDesired(requireUserId(this.cls), asked);
    const rows = await this.demand.getDemand(roles);
    return { items: rows.map((row) => ({ ...row, computedAt: row.computedAt.toISOString() })) };
  }
}
