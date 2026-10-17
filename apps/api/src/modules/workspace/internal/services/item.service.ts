import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import {
  type CompletionIssue,
  completionIssue,
  heldOnIssue,
  type ItemFacts,
} from '../domain/item-rules.js';
import { isStorableLink } from '../domain/link-policy.js';
import { ItemRepository, type ItemChanges } from '../repositories/item.repository.js';
import type { ItemRow, StageRow } from '../repositories/route.repository.js';
import { ItemGate, VersionConflict } from './item-gate.js';
import type { ChecklistItemDto } from './route-dto.js';
import { RouteQueryService } from './route-query.service.js';

type Patch = Body<'updateChecklistItem'>;

/** The queue that checks a saved link (architecture 13.12); the checker itself arrives with S5-09. */
export const LINK_CHECK_QUEUE = 'link-check';

interface Saved {
  version: number;
  linkToCheck: boolean;
}

/**
 * updateChecklistItem (FR-WORK-04, -06, -07, -17, -18, CC-7). A link is judged by its spelling at
 * saving (https, no internal address, SEC-05) and queued for the real check; the write is a
 * conditional UPDATE by `version`, so of N writers with the same version exactly one wins.
 */
@Injectable()
export class ItemService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
    @Inject(ItemGate) private readonly gate: ItemGate,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RouteQueryService) private readonly query: RouteQueryService,
  ) {}

  async update(
    userId: string,
    teamId: string,
    itemId: string,
    body: Patch,
  ): Promise<ChecklistItemDto> {
    await this.checkLinks(userId, teamId, body);
    if (typeof body.roleCode === 'string') {
      await this.profiles.assertRolesExist([body.roleCode], { activeOnly: true });
    }
    let saved: Saved;
    try {
      saved = await this.tx.run(() => this.updateInTx(userId, teamId, itemId, body));
    } catch (error) {
      if (error instanceof VersionConflict) throw await this.gate.conflict(teamId, itemId);
      throw error;
    }
    if (saved.linkToCheck) await this.enqueueLinkCheck(teamId, itemId, saved.version);
    return this.query.getItem(teamId, itemId);
  }

  /** Spelling first (nothing is counted for a refused link), then the hourly limit of saves (SEC-05). */
  private async checkLinks(userId: string, teamId: string, body: Patch): Promise<void> {
    const links = [body.linkUrl, body.externalUrl].filter(
      (l): l is string => typeof l === 'string',
    );
    if (links.length === 0) return;
    if (!links.every(isStorableLink)) throw new DomainError('LINK_REJECTED', 422);
    await this.limiter.enforce('linkCheckUser', this.limiter.userSubject(userId));
    await this.limiter.enforce('linkCheckTeam', `team:${teamId}`);
  }

  private async updateInTx(
    userId: string,
    teamId: string,
    itemId: string,
    body: Patch,
  ): Promise<Saved> {
    const { item, stage } = await this.gate.open(teamId, itemId, { member: userId });
    if (item.version !== body.version) throw new VersionConflict();
    const now = this.clock.now();
    const changes = this.changesOf(item, body, userId, now);
    await this.checkResult(item, stage, body, changes);
    const row = await this.items.updateIfVersion(itemId, body.version, changes, now);
    if (row === undefined) throw new VersionConflict();
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'item_updated',
      aggregateId: itemId,
      payload: { teamId, itemId, version: row.version },
    });
    return { version: row.version, linkToCheck: typeof body.linkUrl === 'string' };
  }

  private changesOf(item: ItemRow, body: Patch, userId: string, now: Date): ItemChanges {
    const changes: ItemChanges = {};
    if (body.linkUrl !== undefined) {
      changes.linkUrl = body.linkUrl;
      changes.linkStatus = body.linkUrl === null ? 'none' : 'unchecked';
      changes.linkCheckedAt = null;
    }
    if (body.heldOn !== undefined) changes.heldOn = body.heldOn;
    if (body.externalUrl !== undefined) changes.externalUrl = body.externalUrl;
    if (body.outcome !== undefined) changes.outcome = body.outcome;
    if (body.roleCode !== undefined) changes.roleCode = body.roleCode;
    if (body.status === 'done' && item.status !== 'done') {
      changes.status = 'done';
      changes.doneBy = userId;
      changes.doneAt = now;
    } else if (body.status === 'open' && item.status !== 'open') {
      changes.status = 'open';
      changes.doneBy = null;
      changes.doneAt = null;
    }
    return changes;
  }

  /** The item as it will be stored must satisfy the rules of a closed item, or of a ritual day. */
  private async checkResult(
    item: ItemRow,
    stage: StageRow,
    body: Patch,
    changes: ItemChanges,
  ): Promise<void> {
    const finalStatus = changes.status ?? item.status;
    const needsFiles = finalStatus === 'done' && item.kind === 'artifact';
    const merged: ItemFacts = {
      kind: item.kind,
      submission: item.submission,
      linkUrl: changes.linkUrl === undefined ? item.linkUrl : changes.linkUrl,
      heldOn: changes.heldOn === undefined ? item.heldOn : changes.heldOn,
      externalUrl: changes.externalUrl === undefined ? item.externalUrl : changes.externalUrl,
      outcome: changes.outcome === undefined ? item.outcome : changes.outcome,
      filesCount: needsFiles ? await this.items.countFiles(item.id) : 0,
    };
    const context = {
      today: this.clock.now().toISOString().slice(0, 10),
      stageOpenedOn: stage.openedAt === null ? null : stage.openedAt.toISOString().slice(0, 10),
    };
    let issue: CompletionIssue | undefined;
    if (finalStatus === 'done') issue = completionIssue(merged, context);
    else if (typeof body.heldOn === 'string') issue = heldOnIssue(body.heldOn, context);
    if (issue === undefined) return;
    const { message } = issue;
    throw new DomainError(issue.code, 422, {
      errors: issue.pointers.map((pointer) => ({ pointer, message })),
    });
  }

  /** After the commit: a repeated add with the same id is a no-op; the S5-09 sweep repairs a lost job. */
  private async enqueueLinkCheck(teamId: string, itemId: string, version: number): Promise<void> {
    await this.queues.add(
      LINK_CHECK_QUEUE,
      'check-item-link',
      { teamId, itemId, version },
      { jobId: jobId('item-link', itemId, version) },
    );
  }
}
