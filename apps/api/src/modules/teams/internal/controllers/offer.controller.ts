import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { OffersDecisionService } from '../services/offers-decision.service.js';
import { OffersQueryService, type OffersQuery } from '../services/offers-query.service.js';
import { OffersService } from '../services/offers.service.js';

/** Offers of the lead and requests of candidates (FR-TEAM-28..30). */
@Controller('v1')
export class OfferController {
  constructor(
    @Inject(OffersService) private readonly offers: OffersService,
    @Inject(OffersDecisionService) private readonly decisions: OffersDecisionService,
    @Inject(OffersQueryService) private readonly queries: OffersQueryService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post('teams/:teamId/seat-offers')
  @Authz('createSeatOffer')
  createSeatOffer(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'createSeatOffer'>,
  ): Promise<Ok<'createSeatOffer'>> {
    return this.offers.createOffer(requireUserId(this.cls), teamId, body);
  }

  @Get('teams/:teamId/seat-offers')
  @Authz('listTeamSeatOffers')
  listTeamSeatOffers(
    @Param('teamId') teamId: string,
    @Query() query: OffersQuery,
  ): Promise<Ok<'listTeamSeatOffers'>> {
    return this.queries.listForTeam(teamId, query);
  }

  @Post('teams/:teamId/join-requests')
  @Authz('createJoinRequest')
  createJoinRequest(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'createJoinRequest'>,
  ): Promise<Ok<'createJoinRequest'>> {
    return this.offers.createRequest(requireUserId(this.cls), teamId, body);
  }

  @Get('me/seat-offers')
  @Authz('listMySeatOffers')
  listMySeatOffers(@Query() query: OffersQuery): Promise<Ok<'listMySeatOffers'>> {
    return this.queries.listMine(requireUserId(this.cls), query);
  }

  @Post('seat-offers/:offerId/acceptance')
  @HttpCode(200)
  @Authz('acceptSeatOffer')
  acceptSeatOffer(@Param('offerId') offerId: string): Promise<Ok<'acceptSeatOffer'>> {
    return this.decisions.accept(requireUserId(this.cls), offerId);
  }

  @Post('seat-offers/:offerId/rejection')
  @HttpCode(200)
  @Authz('rejectSeatOffer')
  rejectSeatOffer(@Param('offerId') offerId: string): Promise<Ok<'rejectSeatOffer'>> {
    return this.decisions.reject(requireUserId(this.cls), offerId);
  }
}
