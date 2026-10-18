import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { Clock } from '../../../../platform/clock/clock.js';
import { InlineDelivery } from '../../../../platform/outbox/inline-delivery.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { type FeedPage, type ItemFeed, RepositoryReader } from '../client/repository-reader.js';
import { type ActiveLink, SyncStateRepository } from '../repositories/sync-state.repository.js';
import { RepoChecksService } from '../services/repo-checks.service.js';
import { ItemEventsHandler } from '../webhook/item-events.handler.js';
import { ItemRepository } from '../webhook/item.repository.js';
import { issueObject, pullRequestObject } from '../webhook/payload-schemas.js';
import type { DeliveryPlan } from '../webhook/plan.js';

/** Pages read per feed and run (100 items each): a repository with more history is finished by the next runs. */
const MAX_PAGES = 30;
/** Items updated this long before the last run are read again, so a clock difference with GitHub loses nothing. */
const OVERLAP_MS = 60 * 60 * 1000;

const listedItem = z.object({
  number: z.number().int().positive(),
  updated_at: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  pull_request: z.unknown().optional(),
});
const reviewTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const SYNC_ITEM_FEEDS: readonly ItemFeed[] = ['pulls', 'issues'];

/**
 * The reconciliation of one repository (FR-GH-06, architecture 7.4): what GitHub lists as changed since
 * the last run goes through the code of the webhook (`ItemEventsHandler`), so a webhook and the sync
 * of the same issue are the same conditional upsert and make one contribution. Pull requests are read
 * before issues: `Closes #n` of a merged pull request then credits the issue it names without waiting.
 * Position and ETags are kept in `repo_sync_state` and move only when a feed was read to the end.
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
  ) {}

  /** Throws `GithubError` when GitHub cannot answer; whatever was stored before stays stored. */
  async syncRepository(link: ActiveLink): Promise<void> {
    const startedAt = this.clock.now();
    const stored = await this.state.state(link.repositoryId);
    const cutoff =
      stored?.lastSyncedAt == null ? null : new Date(stored.lastSyncedAt.getTime() - OVERLAP_MS);
    for (const feed of SYNC_ITEM_FEEDS) {
      const etag = feed === 'issues' ? stored?.issuesEtag : stored?.pullsEtag;
      const newEtag = await this.readFeed(link, feed, etag ?? null, cutoff, startedAt);
      if (newEtag !== undefined) {
        await this.state.saveState(
          link.repositoryId,
          feed === 'issues' ? { issuesEtag: newEtag } : { pullsEtag: newEtag },
        );
      }
    }
    await this.state.saveState(link.repositoryId, { lastSyncedAt: startedAt });
    await this.checkRepository(link);
  }

  /** `repo_check` (exists, archived, private, fork) and the verdict of `ci_workflow`. */
  private async checkRepository(link: ActiveLink): Promise<void> {
    const { repository } = await this.checks.exists(link);
    if (repository === null) return;
    await this.checks.refreshCiState(link, repository.default_branch);
  }

  /** Walks the feed from the newest page until the position of the last run; returns the new ETag, if any. */
  private async readFeed(
    link: ActiveLink,
    feed: ItemFeed,
    etag: string | null,
    cutoff: Date | null,
    receivedAt: Date,
  ): Promise<string | null | undefined> {
    let firstEtag: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const read: FeedPage = await this.reader.listFeed(
        link.installationId,
        link.repositoryId,
        feed,
        page,
        etag,
      );
      if (!read.modified) return undefined;
      if (page === 1) firstEtag = read.etag;
      const behind = await this.handlePage(link, feed, read.items, cutoff, receivedAt);
      if (behind || !read.hasNext) return firstEtag;
    }
    // Not read to the end: the ETag of the first page would hide the rest from the next run.
    return undefined;
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
      if (await this.isKnown(link.repositoryId, feed, listed.data.number, updatedAt)) continue;
      if (feed === 'issues') await this.handleIssue(link, raw, receivedAt);
      else await this.handlePull(link, listed.data.number, receivedAt);
    }
    return false;
  }

  /** The stored item is as new as GitHub's: nothing to do. A placeholder (`source_updated_at` 1970) is never new. */
  private async isKnown(
    repositoryId: number,
    feed: ItemFeed,
    number: number,
    updatedAt: Date,
  ): Promise<boolean> {
    const stored = await this.items.find(repositoryId, feed === 'issues' ? 'issue' : 'pr', number);
    return stored !== undefined && stored.sourceUpdatedAt.getTime() >= updatedAt.getTime();
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
