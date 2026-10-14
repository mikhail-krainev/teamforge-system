import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { VoteBallotService } from '../services/vote-ballot.service.js';
import { VoteLeadReturnService } from '../services/vote-lead-return.service.js';
import { VoteNominateService } from '../services/vote-nominate.service.js';
import { VoteOfferService } from '../services/vote-offer.service.js';
import { type VotesQuery, VoteQueryService } from '../services/vote-query.service.js';
import { VoteRequestService } from '../services/vote-request.service.js';

/** Leader vote: listing, requests, nomination, ballots and the offer (FR-TEAM-14..21). */
@Controller('v1/teams/:teamId')
export class VoteController {
  constructor(
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
    @Inject(VoteRequestService) private readonly requests: VoteRequestService,
    @Inject(VoteNominateService) private readonly nomination: VoteNominateService,
    @Inject(VoteLeadReturnService) private readonly leadReturn: VoteLeadReturnService,
    @Inject(VoteBallotService) private readonly ballots: VoteBallotService,
    @Inject(VoteOfferService) private readonly offers: VoteOfferService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('leader-votes')
  @Authz('listLeaderVotes')
  async listLeaderVotes(
    @Param('teamId') teamId: string,
    @Query() query: VotesQuery,
  ): Promise<Ok<'listLeaderVotes'>> {
    return this.query.list(requireUserId(this.cls), teamId, query);
  }

  @Get('leader-vote-requests')
  @Authz('getLeaderVoteRequests')
  getLeaderVoteRequests(@Param('teamId') teamId: string): Promise<Ok<'getLeaderVoteRequests'>> {
    return this.requests.status(teamId);
  }

  @Post('leader-vote-requests')
  @HttpCode(201)
  @Authz('requestLeaderVote')
  requestLeaderVote(@Param('teamId') teamId: string): Promise<Ok<'requestLeaderVote'>> {
    return this.requests.request(requireUserId(this.cls), teamId);
  }

  @Post('leader-votes/:voteId/candidates')
  @HttpCode(201)
  @Authz('nominateCandidate')
  nominateCandidate(
    @Param('teamId') teamId: string,
    @Param('voteId') voteId: string,
    @Body() body: BodyOf<'nominateCandidate'>,
  ): Promise<Ok<'nominateCandidate'>> {
    return this.nomination.nominate(requireUserId(this.cls), teamId, voteId, body);
  }

  @Post('leader-votes/:voteId/candidates/:candidateUserId/consent')
  @HttpCode(200)
  @Authz('consentCandidacy')
  consentCandidacy(
    @Param('teamId') teamId: string,
    @Param('voteId') voteId: string,
    @Param('candidateUserId') candidateUserId: string,
  ): Promise<Ok<'consentCandidacy'>> {
    return this.nomination.consent(requireUserId(this.cls), teamId, voteId, candidateUserId);
  }

  @Post('leader-votes/:voteId/candidates/me/withdrawal')
  @HttpCode(200)
  @Authz('withdrawCandidacy')
  withdrawCandidacy(
    @Param('teamId') teamId: string,
    @Param('voteId') voteId: string,
  ): Promise<Ok<'withdrawCandidacy'>> {
    return this.nomination.withdraw(requireUserId(this.cls), teamId, voteId);
  }

  @Post('leader-votes/:voteId/ballots')
  @HttpCode(201)
  @Authz('castBallot')
  castBallot(
    @Param('teamId') teamId: string,
    @Param('voteId') voteId: string,
    @Body() body: BodyOf<'castBallot'>,
  ): Promise<Ok<'castBallot'>> {
    return this.ballots.cast(requireUserId(this.cls), teamId, voteId, body);
  }

  @Post('leader-votes/:voteId/lead-return')
  @HttpCode(200)
  @Authz('returnAsLead')
  returnAsLead(
    @Param('teamId') teamId: string,
    @Param('voteId') voteId: string,
  ): Promise<Ok<'returnAsLead'>> {
    return this.leadReturn.returnAsLead(requireUserId(this.cls), teamId, voteId);
  }

  @Post('leader-votes/:voteId/offer-responses')
  @HttpCode(200)
  @Authz('respondLeaderOffer')
  respondLeaderOffer(
    @Param('teamId') teamId: string,
    @Param('voteId') voteId: string,
    @Body() body: BodyOf<'respondLeaderOffer'>,
  ): Promise<Ok<'respondLeaderOffer'>> {
    return this.offers.respond(requireUserId(this.cls), teamId, voteId, body);
  }
}
