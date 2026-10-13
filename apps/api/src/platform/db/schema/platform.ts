import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  uuid,
  integer,
  check,
  boolean,
} from 'drizzle-orm/pg-core';
import { bytea, tstz } from './columns.js';

export const platformSchema = pgSchema('platform');

/** Idempotency keys (architecture 5.1, 12.4). Scope is the pair (user_id, key). */
export const idempotencyKey = platformSchema.table(
  'idempotency_key',
  {
    userId: uuid('user_id').notNull(), // ref auth.user
    key: uuid('key').notNull(),
    operationId: text('operation_id').notNull(),
    requestHash: bytea('request_hash').notNull(),
    status: text('status').notNull(),
    lockedUntil: tstz('locked_until').notNull(),
    lockToken: uuid('lock_token').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    /** True while response_body is the raw transaction result, not yet the final HTTP body. */
    responseProvisional: boolean('response_provisional').notNull().default(false),
    createdAt: tstz('created_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key], name: 'idempotency_key_pkey' }),
    check('idempotency_key_status_check', sql`${t.status} IN ('in_progress','completed')`),
    index('idempotency_key_expires_idx').on(t.expiresAt),
  ],
);

/** Transactional outbox (architecture 4). */
export const outboxEvent = platformSchema.table(
  'outbox_event',
  {
    id: uuid('id').primaryKey(),
    module: text('module').notNull(),
    type: text('type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    requestId: text('request_id'),
    createdAt: tstz('created_at').notNull(),
    publishedAt: tstz('published_at'),
  },
  (t) => [
    index('outbox_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} IS NULL`),
    index('outbox_published_at_idx')
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
  ],
);

/** Consumer-side deduplication of outbox events. */
export const inboxEvent = platformSchema.table(
  'inbox_event',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: tstz('processed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId], name: 'inbox_event_pkey' })],
);

/** Events that exhausted all delivery attempts (payload holds identifiers only). */
export const eventDeadLetter = platformSchema.table(
  'event_dead_letter',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    type: text('type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    error: text('error').notNull(),
    attempts: smallint('attempts').notNull(),
    failedAt: tstz('failed_at').notNull(),
    replayedAt: tstz('replayed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.consumer, t.eventId], name: 'event_dead_letter_pkey' }),
    index('event_dead_letter_open_idx')
      .on(t.failedAt)
      .where(sql`${t.replayedAt} IS NULL`),
  ],
);
