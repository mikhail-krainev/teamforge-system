import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import {
  type OfferCursor,
  type OfferWithRole,
  OfferRepository,
} from '../repositories/offer.repository.js';
import { type OfferDto, toOfferDto } from './offer-dto.js';

export interface OffersQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  status?: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled' | undefined;
}

function keysetOf(payload: CursorPayload): OfferCursor {
  const [at, id] = payload.k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { at: when, id };
}

/** listTeamSeatOffers (the lead) and listMySeatOffers (the user): newest first, keyset pages. */
@Injectable()
export class OffersQueryService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OfferRepository) private readonly offers: OfferRepository,
  ) {}

  async listForTeam(teamId: string, query: OffersQuery): Promise<Page<OfferDto>> {
    const now = this.clock.now();
    const filters = { teamId, status: query.status ?? null };
    const limit = clampLimit(query.limit);
    const rows = await this.offers.listForTeam(
      teamId,
      query.status,
      now,
      this.after(query.cursor, filters),
      limit + 1,
    );
    return this.page(rows, limit, filters, now);
  }

  async listMine(userId: string, query: OffersQuery): Promise<Page<OfferDto>> {
    const filters = { userId };
    const limit = clampLimit(query.limit);
    const rows = await this.offers.listForUser(
      userId,
      this.after(query.cursor, filters),
      limit + 1,
    );
    return this.page(rows, limit, filters, this.clock.now());
  }

  private after(cursor: string | undefined, filters: Record<string, unknown>) {
    return cursor === undefined ? undefined : keysetOf(decodeCursor(cursor, filters));
  }

  private page(
    rows: OfferWithRole[],
    limit: number,
    filters: Record<string, unknown>,
    now: Date,
  ): Page<OfferDto> {
    const page = buildPage(
      rows,
      limit,
      (row) => [row.offer.createdAt.toISOString(), row.offer.id],
      filters,
    );
    return {
      items: page.items.map((row) => toOfferDto(row.offer, row.roleCode, now)),
      nextCursor: page.nextCursor,
    };
  }
}
