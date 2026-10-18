import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  CHECK_ITEM_LINK_JOB,
  LINK_CHECK_QUEUE,
  linkCheckJobId,
} from '../../../../link-checker/protocol.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import {
  type CompletionIssue,
  completionIssue,
  heldOnIssue,
  type ItemFacts,
} from '../domain/item-rules.js';
import { isStorableLink } from '../domain/link-policy.js';
import { ItemRepository, type ItemChanges } from '../repositories/item.repository.js';
import { ReviewRepository } from '../repositories/review.repository.js';
import type { ItemRow, StageRow } from '../repositories/route.repository.js';
import { ItemGate, VersionConflict } from './item-gate.js';
import type { ChecklistItemDto } from './route-dto.js';
import { RouteQueryService } from './route-query.service.js';

type Patch = Body<'updateChecklistItem'>;

interface Saved {
  version: number;
  /** The link that was saved and waits for the `link-checker` (architecture 13.12). */
  linkToCheck: string | undefined;
}

/** A new link or a reopened item is another artifact than the one a review answered. */
function changesJudgedArtifact(item: ItemRow, changes: ItemChanges): boolean {
  const newLink = changes.linkUrl !== undefined && changes.linkUrl !== item.linkUrl;
  return newLink || changes.status === 'open';
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
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(ItemGate) private readonly gate: ItemGate,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(RouteQueryService) private readonly query: RouteQueryService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
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
    if (saved.linkToCheck !== undefined) {
      await this.enqueueLinkCheck(teamId, itemId, saved.version, saved.linkToCheck);
    }
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
    const { team, item, stage } = await this.gate.open(teamId, itemId, { member: userId });
    await this.assertMayWrite(team.leadUserId, item, userId, body);
    if (item.version !== body.version) throw new VersionConflict();
    const now = this.clock.now();
    const changes = this.changesOf(item, body, userId, now);
    await this.checkResult(item, stage, body, changes);
    const row = await this.items.updateIfVersion(itemId, body.version, changes, now);
    if (row === undefined) throw new VersionConflict();
    if (changesJudgedArtifact(item, changes)) await this.reviews.clear(itemId);
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'item_updated',
      aggregateId: itemId,
      payload: { teamId, itemId, version: row.version },
    });
    return {
      version: row.version,
      linkToCheck: typeof body.linkUrl === 'string' ? body.linkUrl : undefined,
    };
  }

  /**
   * x-authz of updateChecklistItem: the fields of an item are written by its executor or by the lead;
   * the role of the contribution is the executor's own choice among the roles he holds (FR-WORK-17).
   * While nobody is assigned (FR-WORK-02, -03): a step of `owner_role: any` is open to every member; any
   * other step to the lead and to a holder of its role (an alternative role included), and a required step on
   * the fallback to the lead alone, who names the executor (an optional one needs no executor).
   */
  private async assertMayWrite(
    leadUserId: string | null,
    item: ItemRow,
    userId: string,
    body: Patch,
  ): Promise<void> {
    const isExecutor =
      item.assigneeUserId === userId ||
      (item.assigneeUserId === null && (await this.mayTakeUp(item, userId)));
    if (!isExecutor && leadUserId !== userId) throw new DomainError('FORBIDDEN', 403);
    if (body.roleCode === undefined) return;
    if (!isExecutor) throw new DomainError('FORBIDDEN', 403);
    const held = await this.rolesHeldBy(item.teamId, userId);
    if (typeof body.roleCode !== 'string' || !held.includes(body.roleCode)) {
      throw new DomainError('VALIDATION_FAILED', 422, {
        errors: [{ pointer: '/roleCode', message: 'The role is not held by the executor' }],
      });
    }
  }

  /** Nobody is assigned: may this member write the item as its prospective executor? */
  private async mayTakeUp(item: ItemRow, userId: string): Promise<boolean> {
    if (item.ownerRole === 'any') return true;
    // An optional step on the fallback needs no executor (FR-WORK-02): it is advice, open to every member.
    if (item.fallbackUsed) return !item.required;
    const held = await this.rolesHeldBy(item.teamId, userId);
    return held.some((role) => role === item.ownerRole || item.altRoles.includes(role));
  }

  private async rolesHeldBy(teamId: string, userId: string): Promise<string[]> {
    const roster = await this.teams.getRoster(teamId);
    return (roster.find((member) => member.userId === userId)?.roles ?? []).map((r) => r.roleCode);
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
    // The blocking part of `link_https` (FR-PLAY-08): a link the link-checker refused cannot close the item.
    const linkKept = changes.linkStatus === undefined && item.linkUrl !== null;
    if (changes.status === 'done' && linkKept && item.linkStatus === 'rejected') {
      throw new DomainError('LINK_REJECTED', 422);
    }
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

  /**
   * After the commit: a repeated add with the same id is a no-op; the sweep of `link-check-sweep`
   * repairs a lost job. The job carries the address because the link-checker reads no database.
   */
  private async enqueueLinkCheck(
    teamId: string,
    itemId: string,
    version: number,
    url: string,
  ): Promise<void> {
    try {
      await this.queues.add(
        LINK_CHECK_QUEUE,
        CHECK_ITEM_LINK_JOB,
        { teamId, itemId, version, url },
        { jobId: linkCheckJobId(itemId, version) },
      );
    } catch (error) {
      // The write is committed: the client must not see a failure for it. `link-check-sweep` queues the check again.
      this.logger.error(
        { err: error, teamId, itemId },
        'link check was not queued; the sweep will',
      );
    }
  }
}
