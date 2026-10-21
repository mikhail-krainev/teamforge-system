import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { githubSchema } from '../../../../platform/db/schema/module-schemas.js';

/** One delivery of GitHub, keyed by `X-GitHub-Delivery` (FR-GH-04, CC-11). `payload` is cleared once handled. */
export const webhookDelivery = githubSchema.table(
  'webhook_delivery',
  {
    deliveryId: text('delivery_id').primaryKey(),
    event: text('event').notNull(),
    action: text('action'),
    installationId: bigint('installation_id', { mode: 'number' }),
    repositoryId: bigint('repository_id', { mode: 'number' }),
    payload: jsonb('payload'),
    status: text('status').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    receivedAt: tstz('received_at').notNull(),
    processedAt: tstz('processed_at'),
  },
  (t) => [
    check(
      'webhook_delivery_status_check',
      sql`${t.status} IN ('received','processed','ignored','failed')`,
    ),
    index('webhook_delivery_pending_idx')
      .on(t.receivedAt)
      .where(sql`${t.status} = 'received'`),
    index('webhook_delivery_received_idx').on(t.receivedAt),
  ],
);

/** An issue or a pull request of a linked repository, as the last event or reconciliation saw it. */
export const ghItem = githubSchema.table(
  'gh_item',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    htmlUrl: text('html_url').notNull(),
    authorGithubId: bigint('author_github_id', { mode: 'number' }),
    assigneeGithubIds: bigint('assignee_github_ids', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'`),
    closerPrNumber: integer('closer_pr_number'),
    state: text('state').notNull(),
    merged: boolean('merged').notNull().default(false),
    labels: text('labels')
      .array()
      .notNull()
      .default(sql`'{}'`),
    additions: integer('additions'),
    deletions: integer('deletions'),
    closedAt: tstz('closed_at'),
    mergedAt: tstz('merged_at'),
    firstReceivedAt: tstz('first_received_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
    /** SEC-06: `updated_at` of the issue or pull request on GitHub; an older event changes nothing. */
    sourceUpdatedAt: tstz('source_updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'gh_item_pkey', columns: [t.repositoryId, t.kind, t.number] }),
    check('gh_item_kind_check', sql`${t.kind} IN ('issue','pr')`),
    index('gh_item_repo_received_idx').on(t.repositoryId, t.firstReceivedAt.desc()),
    index('gh_item_author_idx').on(t.authorGithubId),
  ],
);

/** The last review of a reviewer on a pull request (`pr_cross_review`). */
export const ghPrReview = githubSchema.table(
  'gh_pr_review',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    prNumber: integer('pr_number').notNull(),
    reviewerGithubId: bigint('reviewer_github_id', { mode: 'number' }).notNull(),
    state: text('state').notNull(),
    submittedAt: tstz('submitted_at').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'gh_pr_review_pkey',
      columns: [t.repositoryId, t.prNumber, t.reviewerGithubId],
    }),
  ],
);
