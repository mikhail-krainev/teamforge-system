import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { peerReview, reviewEligibility } from '../schema/profiles.js';

/**
 * `ReceivedReview` of the contract: no author, no time of writing (SEC-04). The text is returned as written (JSON);
 * the place of output escapes it (M-1, S7SEC-08).
 */
export interface ReceivedReviewDto {
  id: string;
  teamId: string;
  teamName: string;
  text: string;
  publishedOn: string;
}

export interface ReceivedReviewsRequest {
  cursor?: string | undefined;
  limit?: number | undefined;
}

interface Keyset {
  publishedOn: string;
  teamId: string;
  sortKey: number;
  id: string;
}

function keysetOf(payload: CursorPayload): Keyset {
  const [publishedOn, teamId, sortKey, id] = payload.k;
  if (
    typeof publishedOn !== 'string' ||
    typeof teamId !== 'string' ||
    typeof sortKey !== 'number' ||
    typeof id !== 'string'
  ) {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { publishedOn, teamId, sortKey, id };
}

/** Rows after the cursor in the order `(published_on DESC, team_id, sort_key, id)`. */
function after(key: Keyset): SQL {
  return sql`(${peerReview.publishedOn} < ${key.publishedOn}::date OR (${peerReview.publishedOn} = ${key.publishedOn}::date
    AND (${peerReview.teamId}, ${peerReview.sortKey}, ${peerReview.id}) > (${key.teamId}::uuid, ${key.sortKey}::int, ${key.id}::uuid)))`;
}

/**
 * What a person reads about himself (`listReceivedReviews`, SEC-04): his `published` reviews only, in
 * the order of the batch. It reads `peer_review` and the project name of his own eligibility row and
 * never touches the authorship table.
 */
@Injectable()
export class ReceivedReviewsQuery {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async list(
    subjectUserId: string,
    request: ReceivedReviewsRequest,
  ): Promise<Page<ReceivedReviewDto>> {
    const filters = { subject: subjectUserId };
    const limit = clampLimit(request.limit);
    const key =
      request.cursor === undefined ? undefined : keysetOf(decodeCursor(request.cursor, filters));
    const rows = await this.fetch(subjectUserId, key, limit + 1);
    const page = buildPage(
      rows,
      limit,
      (row) => [row.publishedOn, row.teamId, row.sortKey, row.id],
      filters,
    );
    return {
      items: page.items.map((row) => ({
        id: row.id,
        teamId: row.teamId,
        teamName: row.teamName,
        text: row.text,
        publishedOn: row.publishedOn,
      })),
      nextCursor: page.nextCursor,
    };
  }

  private fetch(subjectUserId: string, key: Keyset | undefined, count: number) {
    return this.tx.tx
      .select({
        id: peerReview.id,
        teamId: peerReview.teamId,
        teamName: sql<string>`coalesce(${reviewEligibility.teamName}, '')`,
        text: peerReview.text,
        publishedOn: sql<string>`${peerReview.publishedOn}::text`,
        sortKey: peerReview.sortKey,
      })
      .from(peerReview)
      .leftJoin(
        reviewEligibility,
        and(
          eq(reviewEligibility.teamId, peerReview.teamId),
          eq(reviewEligibility.userId, peerReview.subjectUserId),
        ),
      )
      .where(
        and(
          eq(peerReview.subjectUserId, subjectUserId),
          eq(peerReview.status, 'published'),
          key === undefined ? undefined : after(key),
        ),
      )
      .orderBy(
        desc(peerReview.publishedOn),
        asc(peerReview.teamId),
        asc(peerReview.sortKey),
        asc(peerReview.id),
      )
      .limit(count);
  }
}
