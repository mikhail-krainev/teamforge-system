import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import {
  type CursorPayload,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { type ContributionRow, FeedRepository } from './feed.repository.js';

export type FeedEntryDto = Ok<'getTeamFeed'>['items'][number];
export type ContributionSummaryDto = Ok<'getContributionSummary'>;

export interface FeedQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  userId?: string | undefined;
  source?: FeedEntryDto['source'] | undefined;
}

export function toFeedEntry(row: ContributionRow): FeedEntryDto {
  return {
    id: row.id,
    source: row.source as FeedEntryDto['source'],
    ref: row.ref,
    title: row.title,
    url: row.url,
    userId: row.userId,
    roleCode: row.roleCode,
    stageOrdinal: row.stageOrdinal,
    active: row.active,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  };
}

function positionOf(payload: CursorPayload): { at: Date; id: string } {
  const [at, id] = payload.k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { at: when, id };
}

const SOURCE_COLUMN = {
  issue: 'issues',
  pr: 'prs',
  artifact: 'artifacts',
  ritual: 'rituals',
} as const;

/**
 * getTeamFeed and getContributionSummary (FR-WORK-16, FR-GH-05). The team comes from the path and the
 * guard has already checked that the caller is its member; every query is bound to that team, so a
 * filter by a stranger is an empty page and nothing of another team can show up.
 */
@Injectable()
export class FeedService {
  constructor(
    @Inject(FeedRepository) private readonly feed: FeedRepository,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
  ) {}

  async list(teamId: string, query: FeedQuery): Promise<Ok<'getTeamFeed'>> {
    const limit = clampLimit(query.limit);
    // The cursor is valid for the filters it was made with (a changed filter is a 400, not a wrong page).
    const filters = { teamId, userId: query.userId ?? null, source: query.source ?? null };
    const after =
      query.cursor === undefined ? undefined : positionOf(decodeCursor(query.cursor, filters));
    const rows = await this.feed.page(
      { teamId, userId: query.userId, source: query.source },
      after,
      limit + 1,
    );
    const page = buildPage(rows, limit, (row) => [row.receivedAt.toISOString(), row.id], filters);
    return { items: page.items.map(toFeedEntry), nextCursor: page.nextCursor };
  }

  async summary(teamId: string): Promise<ContributionSummaryDto> {
    const [roster, counts, unassignedItemIds] = await Promise.all([
      this.teams.getRoster(teamId),
      this.feed.countActive(teamId),
      this.feed.unassignedItemIds(teamId),
    ]);
    // Members who left keep the credit they earned: they stay in the summary after the roster forgets them.
    const userIds = [...new Set([...roster.map((m) => m.userId), ...counts.map((c) => c.userId)])];
    const members = userIds.map((userId) => {
      const byRole = new Map<
        string,
        { roleCode: string; issues: number; prs: number; artifacts: number; rituals: number }
      >();
      for (const count of counts.filter((c) => c.userId === userId)) {
        const column = SOURCE_COLUMN[count.source as keyof typeof SOURCE_COLUMN];
        const entry = byRole.get(count.roleCode) ?? {
          roleCode: count.roleCode,
          issues: 0,
          prs: 0,
          artifacts: 0,
          rituals: 0,
        };
        entry[column] += count.count;
        byRole.set(count.roleCode, entry);
      }
      return {
        userId,
        byRole: [...byRole.values()].sort((a, b) => a.roleCode.localeCompare(b.roleCode)),
      };
    });
    return { members, unassignedItemIds };
  }
}
