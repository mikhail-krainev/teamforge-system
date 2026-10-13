import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import {
  JOINABLE_STATUSES,
  MAX_PENDING_OFFERS_PER_TEAM,
  MAX_PENDING_REQUESTS_PER_USER,
  OFFER_TTL_MS,
} from '../domain/join-rules.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { OfferRepository } from '../repositories/offer.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { type OfferDto, toOfferDto } from './offer-dto.js';
import { journalRow, teamsEvent } from './team-events.js';
import { TeamLeadLock } from './team-lead-lock.js';

type OfferBody = Body<'createSeatOffer'>;
type RequestBody = Body<'createJoinRequest'>;

interface NewOffer {
  teamId: string;
  seatId: string;
  roleCode: string;
  userId: string;
  actorId: string;
  direction: 'lead_to_user' | 'user_to_lead';
  message?: string | undefined;
}

/** createSeatOffer (FR-TEAM-28) and createJoinRequest (FR-TEAM-29); neither reserves the seat. */
@Injectable()
export class OffersService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(OfferRepository) private readonly offers: OfferRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
  ) {}

  /** The addressee is checked before BEGIN (reference read); the 30-per-team limit under lock #4. */
  async createOffer(leadId: string, teamId: string, body: OfferBody): Promise<OfferDto> {
    const identity = await this.auth.getIdentity(body.userId);
    if (identity === null) throw new DomainError('NOT_FOUND', 404);
    if (identity.status !== 'active') throw new DomainError('USER_INACTIVE', 409);
    return this.tx.run(() => this.createOfferInTx(leadId, teamId, body));
  }

  private async createOfferInTx(
    leadId: string,
    teamId: string,
    body: OfferBody,
  ): Promise<OfferDto> {
    const team = await this.leadLock.lock(teamId, leadId);
    if (!JOINABLE_STATUSES.includes(team.status)) throw new DomainError('INVALID_STATE', 409);
    const roleCode = await this.openSeatRole(teamId, body.seatId);
    const now = this.clock.now();
    await this.assertNoDuplicate(body.seatId, body.userId, now);
    if ((await this.offers.countPendingOffers(teamId, now)) >= MAX_PENDING_OFFERS_PER_TEAM) {
      throw new DomainError('OFFER_LIMIT', 409);
    }
    return this.store(
      { ...body, teamId, roleCode, actorId: leadId, direction: 'lead_to_user' },
      now,
    );
  }

  /** Lock #1 serializes the requests of one candidate, so the limit of 10 is exact. */
  createRequest(userId: string, teamId: string, body: RequestBody): Promise<OfferDto> {
    return this.tx.run(() => this.createRequestInTx(userId, teamId, body));
  }

  private async createRequestInTx(
    userId: string,
    teamId: string,
    body: RequestBody,
  ): Promise<OfferDto> {
    const eligibility = await this.auth.lockUserForJoin(userId);
    if (eligibility.githubUserId === null) throw new DomainError('GITHUB_REQUIRED', 409);
    if (!eligibility.consentValid) throw new DomainError('CONSENT_REQUIRED', 403);
    const team = await this.teams.find(teamId);
    if (team === undefined) throw new DomainError('NOT_FOUND', 404);
    if (!JOINABLE_STATUSES.includes(team.status)) throw new DomainError('INVALID_STATE', 409);
    const roleCode = await this.openSeatRole(teamId, body.seatId);
    if ((await this.joins.activeMembership(teamId, userId)) !== undefined) {
      throw new DomainError('ALREADY_MEMBER', 409);
    }
    const now = this.clock.now();
    await this.assertNoDuplicate(body.seatId, userId, now);
    if ((await this.offers.countPendingRequests(userId, now)) >= MAX_PENDING_REQUESTS_PER_USER) {
      throw new DomainError('OFFER_LIMIT', 409);
    }
    return this.store(
      { ...body, userId, teamId, roleCode, actorId: userId, direction: 'user_to_lead' },
      now,
    );
  }

  /** The seat must belong to the team (else 404, the id is part of the chain) and be `open`. */
  private async openSeatRole(teamId: string, seatId: string): Promise<string> {
    const [seat] = await this.seats.listByTeam(teamId, [seatId]);
    if (seat === undefined) throw new DomainError('NOT_FOUND', 404);
    if (seat.status !== 'open') throw new DomainError('SEAT_NOT_OPEN', 409);
    return seat.roleCode;
  }

  /** One pending offer or request per (seat, user); an overdue one is retired first. */
  private async assertNoDuplicate(seatId: string, userId: string, now: Date): Promise<void> {
    await this.offers.expireStale(seatId, userId, now);
    if (await this.offers.hasPending(seatId, userId, now)) {
      throw new DomainError('INVALID_STATE', 409);
    }
  }

  private async store(input: NewOffer, now: Date): Promise<OfferDto> {
    const row = {
      id: uuidv7(),
      teamId: input.teamId,
      seatId: input.seatId,
      userId: input.userId,
      direction: input.direction,
      status: 'pending',
      message: input.message ?? null,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      createdAt: now,
      decidedAt: null,
    };
    await this.offers.insert(row);
    const payload = {
      offerId: row.id,
      teamId: row.teamId,
      seatId: row.seatId,
      userId: row.userId,
      direction: row.direction,
    };
    await this.events.insertMany([
      journalRow(row.teamId, 'offer_created', input.actorId, payload, now),
    ]);
    await this.outbox.publishMany([teamsEvent('offer_created', row.id, payload)]);
    return toOfferDto(row, input.roleCode, now);
  }
}
