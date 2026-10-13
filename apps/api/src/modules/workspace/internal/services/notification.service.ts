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

function toDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload as NotificationDto['payload'],
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
  ) {}

  async list(userId: string, query: NotificationQuery): Promise<Page<NotificationDto>> {
    const unread = query.unread === true;
    const filters = { userId, unread };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, filters));
    const rows = await this.notifications.listForUser(userId, unread, after, limit + 1);
    const page = buildPage(rows, limit, (r) => [r.createdAt.toISOString(), r.id], filters);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  /** Ids that are not the caller's are ignored without a trace: the answer is the same 204. */
  async markRead(userId: string, ids: string[]): Promise<void> {
    await this.notifications.markRead(userId, [...new Set(ids)], this.clock.now());
  }
}
