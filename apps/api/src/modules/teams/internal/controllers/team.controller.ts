import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { API_PREFIX } from '../../../../platform/http/fastify.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { TeamQueryService } from '../services/team-query.service.js';
import type { CatalogQuery, EventsQuery, MyTeamsQuery } from '../services/team-query.service.js';
import { TeamService } from '../services/team.service.js';

/** createTeam, getTeam, listTeams, updateTeam, listMyTeams, listTeamEvents (FR-TEAM-01..06). */
@Controller('v1')
export class TeamController {
  constructor(
    @Inject(TeamService) private readonly teams: TeamService,
    @Inject(TeamQueryService) private readonly queries: TeamQueryService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('teams')
  @Authz('listTeams')
  listTeams(@Query() query: CatalogQuery): Promise<Ok<'listTeams'>> {
    return this.queries.list(query);
  }

  @Post('teams')
  @Authz('createTeam')
  async createTeam(
    @Body() body: BodyOf<'createTeam'>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Ok<'createTeam'>> {
    const { team, teamId } = await this.teams.create(requireUserId(this.cls), body);
    void reply.header('Location', `/${API_PREFIX}/v1/teams/${teamId}`);
    return team;
  }

  @Get('teams/:teamId')
  @Authz('getTeam')
  getTeam(@Param('teamId') teamId: string): Promise<Ok<'getTeam'>> {
    return this.queries.get(teamId, requireUserId(this.cls));
  }

  @Patch('teams/:teamId')
  @Authz('updateTeam')
  updateTeam(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'updateTeam'>,
  ): Promise<Ok<'updateTeam'>> {
    return this.teams.update(requireUserId(this.cls), teamId, body);
  }

  @Get('me/teams')
  @Authz('listMyTeams')
  listMyTeams(@Query() query: MyTeamsQuery): Promise<Ok<'listMyTeams'>> {
    return this.queries.listMine(requireUserId(this.cls), query);
  }

  @Get('teams/:teamId/events')
  @Authz('listTeamEvents')
  listTeamEvents(
    @Param('teamId') teamId: string,
    @Query() query: EventsQuery,
  ): Promise<Ok<'listTeamEvents'>> {
    return this.queries.listEvents(teamId, query);
  }
}
