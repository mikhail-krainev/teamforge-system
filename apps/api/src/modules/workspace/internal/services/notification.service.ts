import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import {
  type NotificationRow,
  NotificationRepository,
} from '../repositories/notification.repository.js';

/** The contract types the payload as an opaque object. */
export type NotificationDto = Ok<'listNotifications'>['items'][number];

export interface NotificationQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  unread?: boolean | undefined;
}

/** Payload key that names the person a notification of this type is about (ids only, SEC-11). */
const ACTOR_KEY: Record<string, string> = {
  invitation_accepted: 'userId',
  member_joined: 'userId',
  member_left: 'userId',
  lead_changed: 'toUserId',
};

function actorIdOf(row: NotificationRow): string | undefined {
  const key = ACTOR_KEY[row.type];
  const id = key === undefined ? undefined : (row.payload as Record<string, unknown>)[key];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function toDto(row: NotificationRow, names: Map<string, string>): NotificationDto {
  const actorId = actorIdOf(row);
  const actorDisplayName = actorId === undefined ? undefined : names.get(actorId);
  return {
    id: row.id,
    type: row.type,
    payload: row.payload as NotificationDto['payload'],
    ...(actorDisplayName === undefined ? {} : { actorDisplayName }),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
}

function keysetOf(payload: CursorPayload): { at: Date; id: string } {
  const [at, id] = payload.k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { at: when, id };
}

/** listNotifications and markNotificationsRead (FR-WORK-19): always about the caller's own rows. */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
  ) {}

  async list(userId: string, query: NotificationQuery): Promise<Page<NotificationDto>> {
    const unread = query.unread === true;
    const filters = { userId, unread };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, filters));
    const rows = await this.notifications.listForUser(userId, unread, after, limit + 1);
    const page = buildPage(rows, limit, (r) => [r.createdAt.toISOString(), r.id], filters);
    // Names are resolved now, in one batch, and never stored in the row (SEC-11); a user without a
    // profile comes back as the deleted placeholder.
    const actorIds = [...new Set(page.items.map(actorIdOf).filter((id) => id !== undefined))];
    const names = await this.profiles.getDisplayNames(actorIds);
    return { items: page.items.map((row) => toDto(row, names)), nextCursor: page.nextCursor };
  }

  /** Ids that are not the caller's are ignored without a trace: the answer is the same 204. */
  async markRead(userId: string, ids: string[]): Promise<void> {
    await this.notifications.markRead(userId, [...new Set(ids)], this.clock.now());
  }
}
