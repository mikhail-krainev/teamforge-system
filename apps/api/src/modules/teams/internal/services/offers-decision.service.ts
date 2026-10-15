import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { CommittedDomainError, DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import type { JoinRejectCode, JoinSeatResult } from '../../public.js';
import { cancelsOffer, joinRefusalStatus } from '../domain/join-rules.js';
import { OfferRepository, type OfferRow } from '../repositories/offer.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { JoinService } from './join.service.js';
import { type JoinResultDto, type OfferDto, toOfferDto } from './offer-dto.js';

interface RawTeam {
  lead_user_id: string | null;
}

/** What the transaction decided; a refusal that wrote something is thrown only after COMMIT. */
type Outcome =
  { kind: 'joined'; result: JoinResultDto } | { kind: 'refused'; code: JoinRejectCode };

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', 404);
}

/** Who may answer an offer and who may withdraw it (SEC-03): by direction, never by role alone. */
function partiesOf(offer: OfferRow, callerId: string, leadId: string | null) {
  const isUser = offer.userId === callerId;
  const isLead = leadId !== null && leadId === callerId;
  const toUser = offer.direction === 'lead_to_user';
  return { responder: toUser ? isUser : isLead, creator: toUser ? isLead : isUser };
}

/** acceptSeatOffer and rejectSeatOffer (FR-TEAM-30); locks #1 user -> #3 offer -> #4 team -> #5 seat. */
@Injectable()
export class OffersDecisionService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(OfferRepository) private readonly offers: OfferRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(JoinService) private readonly join: JoinService,
  ) {}

  /** The joining user is locked, not the caller: when the lead accepts a request it is the requester. */
  async accept(callerId: string, offerId: string): Promise<JoinResultDto> {
    const known = await this.offers.find(offerId);
    if (known === undefined) throw notFound();
    const outcome = await this.tx.run(() => this.acceptInTx(callerId, known.userId, offerId));
    if (outcome.kind === 'joined') return outcome.result;
    throw new CommittedDomainError(outcome.code, joinRefusalStatus(outcome.code));
  }

  private async acceptInTx(callerId: string, joiningId: string, offerId: string): Promise<Outcome> {
    await this.auth.lockUserForJoin(joiningId);
    const offer = await this.lockOffer(offerId);
    const team = await this.locks.lockTeam<RawTeam & Record<string, unknown>>(offer.teamId);
    if (!partiesOf(offer, callerId, team?.lead_user_id ?? null).responder) throw notFound();
    const now = this.clock.now();
    if (offer.status !== 'pending') throw new DomainError('INVALID_STATE', 409);
    if (offer.expiresAt <= now) return this.retire(offer, 'expired', 'INVALID_STATE', now);
    const joined = await this.join.join({
      seatId: offer.seatId,
      userId: offer.userId,
      via: offer.direction === 'lead_to_user' ? 'offer' : 'request',
      userLocked: true,
    });
    if (!joined.ok) return this.refusal(offer, joined.code, now);
    await this.offers.setStatus(offer.id, 'accepted', now);
    return { kind: 'joined', result: this.toResult(offer, joined) };
  }

  /** The seat changed under the offer: it is cancelled and the answer is committed with it. */
  private async refusal(offer: OfferRow, code: JoinRejectCode, now: Date): Promise<Outcome> {
    if (cancelsOffer(code)) return this.retire(offer, 'cancelled', code, now);
    throw new DomainError(code, joinRefusalStatus(code));
  }

  private async retire(
    offer: OfferRow,
    status: 'expired' | 'cancelled',
    code: JoinRejectCode,
    now: Date,
  ): Promise<Outcome> {
    await this.offers.setStatus(offer.id, status, now);
    return { kind: 'refused', code };
  }

  private toResult(offer: OfferRow, joined: Extract<JoinSeatResult, { ok: true }>): JoinResultDto {
    return {
      teamId: joined.teamId,
      seatId: joined.seatId,
      roleCode: joined.roleCode,
      joinedVia: offer.direction === 'lead_to_user' ? 'offer' : 'request',
      trialUntil: joined.trialUntil?.toISOString() ?? null,
      deficitAtJoin: joined.deficitAtJoin,
    };
  }

  /** Lock #3. The row is re-read through the repository once it is locked (typed dates). */
  private async lockOffer(offerId: string): Promise<OfferRow> {
    const locked = await this.locks.lockTicket('seatOffer', offerId);
    const offer = locked === undefined ? undefined : await this.offers.find(offerId);
    if (offer === undefined) throw notFound();
    return offer;
  }

  /** The responder rejects (`rejected`); the creator withdraws (`cancelled`); anyone else gets 404. */
  async reject(callerId: string, offerId: string): Promise<OfferDto> {
    return this.tx.run(() => this.rejectInTx(callerId, offerId));
  }

  private async rejectInTx(callerId: string, offerId: string): Promise<OfferDto> {
    const offer = await this.lockOffer(offerId);
    const team = await this.locks.lockTeam<RawTeam & Record<string, unknown>>(
      offer.teamId,
      'share',
    );
    const parties = partiesOf(offer, callerId, team?.lead_user_id ?? null);
    if (!parties.responder && !parties.creator) throw notFound();
    const now = this.clock.now();
    // An overdue offer is no longer waiting for an answer, same as in accept (S3CR-06).
    if (offer.status !== 'pending' || offer.expiresAt <= now) {
      throw new DomainError('INVALID_STATE', 409);
    }
    const status = parties.responder ? 'rejected' : 'cancelled';
    await this.offers.setStatus(offer.id, status, now);
    const [seat] = await this.seats.listByTeam(offer.teamId, [offer.seatId]);
    return toOfferDto({ ...offer, status, decidedAt: now }, seat?.roleCode ?? '', now);
  }
}
