import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { DepartureLeaveService } from '../services/departure-leave.service.js';
import { type DeparturesQuery, DepartureService } from '../services/departure.service.js';

/** leaveTeam, listDepartures and decideDeparture (FR-TEAM-11..13). */
@Controller('v1/teams/:teamId')
export class DepartureController {
  constructor(
    @Inject(DepartureLeaveService) private readonly leaving: DepartureLeaveService,
    @Inject(DepartureService) private readonly departures: DepartureService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Delete('members/me')
  @HttpCode(204)
  @Authz('leaveTeam')
  async leaveTeam(@Param('teamId') teamId: string): Promise<void> {
    await this.leaving.leave(requireUserId(this.cls), teamId);
  }

  @Get('departures')
  @Authz('listDepartures')
  listDepartures(
    @Param('teamId') teamId: string,
    @Query() query: DeparturesQuery,
  ): Promise<Ok<'listDepartures'>> {
    return this.departures.list(teamId, query);
  }

  @Post('departures/:departureId/decision')
  @HttpCode(200)
  @Authz('decideDeparture')
  decideDeparture(
    @Param('teamId') teamId: string,
    @Param('departureId') departureId: string,
    @Body() body: BodyOf<'decideDeparture'>,
  ): Promise<Ok<'decideDeparture'>> {
    return this.departures.decide(requireUserId(this.cls), teamId, departureId, body);
  }
}
