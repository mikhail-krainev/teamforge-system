import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { Clock } from '../../../../platform/clock/clock.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { InlineDelivery } from '../../../../platform/outbox/inline-delivery.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { type FeedPage, type ItemFeed, RepositoryReader } from '../client/repository-reader.js';
import {
  type ActiveLink,
  type SyncStatePatch,
  type SyncStateRow,
  SyncStateRepository,
} from '../repositories/sync-state.repository.js';
import { RepoChecksService } from '../services/repo-checks.service.js';
import { ItemEventsHandler } from '../webhook/item-events.handler.js';
import { ItemRepository, type ItemStamp, supersedes } from '../webhook/item.repository.js';
import { issueObject, pullRequestObject } from '../webhook/payload-schemas.js';
import type { DeliveryPlan } from '../webhook/plan.js';

/** Items updated this long before the last run are read again, so a clock difference with GitHub loses nothing. */
const OVERLAP_MS = 60 * 60 * 1000;

const listedItem = z.object({
  number: z.number().int().positive(),
  updated_at: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  pull_request: z.unknown().optional(),
  state: z.string().optional(),
  merged_at: z.string().nullish(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  assignees: z.array(z.object({ id: z.number() })).default([]),
});
type ListedItem = z.infer<typeof listedItem>;
const reviewTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

/** The version of an item as the list of GitHub shows it (the list of pull requests has `merged_at`, not `merged`). */
function listedStamp(listed: ListedItem): ItemStamp {
  return {
    sourceUpdatedAt: new Date(listed.updated_at),
    state: listed.state ?? 'open',
    merged: listed.merged_at != null,
    labels: listed.labels.map((l) => l.name),
    assigneeGithubIds: listed.assignees.map((a) => a.id),
  };
}

/**
 * The end of a run: when both feeds are read, `last_synced_at` moves to the start of the first run of
 * the round; otherwise the round is remembered (its start) and `last_synced_at` stays.
 */
function roundPatch(
  stored: SyncStateRow | undefined,
  finished: boolean,
  startedAt: Date,
): SyncStatePatch {
  if (finished) {
    return { lastSyncedAt: stored?.pendingSyncStartedAt ?? startedAt, pendingSyncStartedAt: null };
  }
  return { pendingSyncStartedAt: stored?.pendingSyncStartedAt ?? startedAt };
}

const SYNC_ITEM_FEEDS: readonly ItemFeed[] = ['pulls', 'issues'];

/** The columns of `repo_sync_state` that belong to one feed. */
const FEED_COLUMNS = {
  issues: { etag: 'issuesEtag', resumePage: 'issuesResumePage' },
  pulls: { etag: 'pullsEtag', resumePage: 'pullsResumePage' },
} as const;

/** What reading one feed in one run came to: the state to keep, and whether the feed was read as far as it goes. */
interface FeedRun {
  finished: boolean;
  patch: SyncStatePatch;
}

/**
 * The reconciliation of one repository (FR-GH-06, architecture 7.4): what GitHub lists as changed since
 * the last run goes through the code of the webhook (`ItemEventsHandler`), so a webhook and the sync
 * of the same issue are the same conditional upsert and make one contribution. Pull requests are read
 * before issues: `Closes #n` of a merged pull request then credits the issue it names without waiting.
 * Position and ETags are kept in `repo_sync_state`. A feed that is longer than the page budget of a run
 * is not finished: its next page is kept (`*_resume_page`), `last_synced_at` stays where it was, and the
 * hourly `github-sync-resume` continues from that page until both feeds reach the position of the last
 * complete run; only then `last_synced_at` moves (to the start of the first run of the round).
 */
@Injectable()
export class RepoSyncService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(InlineDelivery) private readonly inline: InlineDelivery,
    @Inject(RepositoryReader) private readonly reader: RepositoryReader,
    @Inject(SyncStateRepository) private readonly state: SyncStateRepository,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(ItemEventsHandler) private readonly itemEvents: ItemEventsHandler,
    @Inject(RepoChecksService) private readonly checks: RepoChecksService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Throws `GithubError` when GitHub cannot answer; whatever was stored before stays stored. */
  async syncRepository(link: ActiveLink): Promise<void> {
    const startedAt = this.clock.now();
    const stored = await this.state.state(link.repositoryId);
    const cutoff =
      stored?.lastSyncedAt == null ? null : new Date(stored.lastSyncedAt.getTime() - OVERLAP_MS);
    let finished = true;
    for (const feed of SYNC_ITEM_FEEDS) {
      const run = await this.readFeed(link, feed, stored, cutoff, startedAt);
      await this.state.saveState(link.repositoryId, run.patch);
      finished = finished && run.finished;
    }
    await this.state.saveState(link.repositoryId, roundPatch(stored, finished, startedAt));
    await this.checkRepository(link);
  }

  /** `repo_check` (exists, archived, private, fork) and the verdict of `ci_workflow`. */
  private async checkRepository(link: ActiveLink): Promise<void> {
    const { repository } = await this.checks.exists(link);
    if (repository === null) return;
    await this.checks.refreshCiState(link, repository.default_branch);
  }

  /**
   * Walks the feed from the newest page (or from the page the last run stopped at) until the position of
   * the last complete run, for at most the page budget. The ETag of the first page is kept only when
   * this run started there and reached the end: it would hide the unread rest from the next run.
   */
  private async readFeed(
    link: ActiveLink,
    feed: ItemFeed,
    stored: SyncStateRow | undefined,
    cutoff: Date | null,
    receivedAt: Date,
  ): Promise<FeedRun> {
    const columns = FEED_COLUMNS[feed];
    const firstPage = stored?.[columns.resumePage] ?? 1;
    const lastPage = firstPage + this.config.GITHUB_SYNC_MAX_PAGES - 1;
    const etag = firstPage === 1 ? (stored?.[columns.etag] ?? null) : null;
    let firstEtag: string | null | undefined;
    for (let page = firstPage; page <= lastPage; page += 1) {
      const read: FeedPage = await this.reader.listFeed(
        link.installationId,
        link.repositoryId,
        feed,
        page,
        etag,
      );
      if (!read.modified) return { finished: true, patch: { [columns.resumePage]: null } };
      if (page === 1) firstEtag = read.etag;
      const behind = await this.handlePage(link, feed, read.items, cutoff, receivedAt);
      if (behind || !read.hasNext) {
        const patch: SyncStatePatch = { [columns.resumePage]: null };
        if (firstEtag !== undefined) patch[columns.etag] = firstEtag;
        return { finished: true, patch };
      }
    }
    return { finished: false, patch: { [columns.resumePage]: lastPage + 1 } };
  }

  /** True when the page reached items older than the last run. */
  private async handlePage(
    link: ActiveLink,
    feed: ItemFeed,
    raws: unknown[],
    cutoff: Date | null,
    receivedAt: Date,
  ): Promise<boolean> {
    for (const raw of raws) {
      const listed = listedItem.safeParse(raw);
      if (!listed.success) continue;
      const updatedAt = new Date(listed.data.updated_at);
      if (cutoff !== null && updatedAt < cutoff) return true;
      if (feed === 'issues' && listed.data.pull_request !== undefined) continue;
      if (await this.isKnown(link.repositoryId, feed, listed.data)) continue;
      if (feed === 'issues') await this.handleIssue(link, raw, receivedAt);
      else await this.handlePull(link, listed.data.number, receivedAt);
    }
    return false;
  }

  /**
   * The stored item says all that GitHub's listing does. Equal `updated_at` is not enough (GitHub stamps
   * whole seconds): a listing that went further, or has other labels or assignees, is news (`supersedes`).
   * A placeholder (`source_updated_at` 1970) is never current.
   */
  private async isKnown(
    repositoryId: number,
    feed: ItemFeed,
    listed: ListedItem,
  ): Promise<boolean> {
    const stored = await this.items.find(
      repositoryId,
      feed === 'issues' ? 'issue' : 'pr',
      listed.number,
    );
    if (stored === undefined) return false;
    return !supersedes(listedStamp(listed), stored);
  }

  private async handleIssue(link: ActiveLink, raw: unknown, receivedAt: Date): Promise<void> {
    const parsed = issueObject.safeParse(raw);
    if (!parsed.success) return this.skipped(link, 'issues', parsed.error);
    await this.apply(await this.itemEvents.issue(link, parsed.data, receivedAt));
  }

  private async handlePull(link: ActiveLink, number: number, receivedAt: Date): Promise<void> {
    const raw = await this.reader.getPull(link.installationId, link.repositoryId, number);
    const parsed = pullRequestObject.safeParse(raw);
    if (!parsed.success) return this.skipped(link, 'pulls', parsed.error);
    await this.apply(await this.itemEvents.pullRequest(link, parsed.data, receivedAt));
    if (parsed.data.merged) await this.readReviews(link, number, receivedAt);
  }

  /** The last review of each reviewer of a merged pull request: what `pr_cross_review` reads. */
  private async readReviews(link: ActiveLink, number: number, receivedAt: Date): Promise<void> {
    const reviews = await this.reader.listReviews(link.installationId, link.repositoryId, number);
    for (const review of reviews) {
      if (review.user === null) continue;
      const submitted = reviewTime.safeParse(review.submitted_at);
      const reviewerGithubId = review.user.id;
      await this.tx.run(() =>
        this.items.upsertReview({
          repositoryId: link.repositoryId,
          prNumber: number,
          reviewerGithubId,
          state: review.state.toLowerCase(),
          submittedAt: submitted.success ? new Date(submitted.data) : receivedAt,
        }),
      );
    }
  }

  /** Writes under the lock of the item and hands the events to their consumers in the same transaction, like a webhook does. */
  private async apply(plan: DeliveryPlan): Promise<void> {
    if (plan.kind !== 'apply') return;
    await this.tx.run(async () => {
      await this.inline.deliver(await plan.run());
    });
  }

  private skipped(link: ActiveLink, feed: ItemFeed, error: z.ZodError): void {
    this.logger.warn(
      { repository_id: link.repositoryId, feed, fields: error.issues.map((i) => i.path.join('.')) },
      'github-sync: an item does not fit the schema, skipped',
    );
  }
}
