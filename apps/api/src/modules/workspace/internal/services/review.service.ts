import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  PLAYBOOKS_API,
  type PlaybooksApi,
  type StepDefinition,
} from '../../../playbooks/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { authorsOf, isReviewPassed, unknownOrdinals } from '../domain/review-rules.js';
import { ItemRepository } from '../repositories/item.repository.js';
import { ReviewRepository } from '../repositories/review.repository.js';
import { RouteRepository, type ItemRow } from '../repositories/route.repository.js';
import { ItemGate, VersionConflict } from './item-gate.js';
import type { ChecklistItemDto } from './route-dto.js';
import { RouteQueryService } from './route-query.service.js';

const REASON_MIN = 10;

type PlaybookId = Parameters<PlaybooksApi['getDefinition']>[0];

/**
 * submitReview and acceptReviewRisk (FR-WORK-09, CC-7) and the question the stage transition asks
 * (S5-08): which required items of the stage still lack a passed review. Both writes go through the
 * item gate (lock #4 share, #8 share) and bump the item's `version` by a conditional UPDATE.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(ItemGate) private readonly gate: ItemGate,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RouteRepository) private readonly route: RouteRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(RouteQueryService) private readonly query: RouteQueryService,
  ) {}

  async submit(
    userId: string,
    teamId: string,
    itemId: string,
    body: Body<'submitReview'>,
  ): Promise<ChecklistItemDto> {
    await this.guarded(teamId, itemId, () => this.submitInTx(userId, teamId, itemId, body));
    return this.query.getItem(teamId, itemId);
  }

  async acceptRisk(
    leadId: string,
    teamId: string,
    itemId: string,
    body: Body<'acceptReviewRisk'>,
  ): Promise<ChecklistItemDto> {
    await this.guarded(teamId, itemId, () => this.acceptInTx(leadId, teamId, itemId, body));
    return this.query.getItem(teamId, itemId);
  }

  /**
   * "Review passed or risk accepted" for the transition check (S5-08): the step keys of the DONE,
   * required items of the stage whose review checklist is not passed. Call it inside the
   * transition's transaction, after the stage lock.
   */
  async unpassedStepKeys(
    teamId: string,
    stageId: string,
    playbookId: PlaybookId,
  ): Promise<string[]> {
    const stage = await this.items.findStage(teamId, stageId);
    if (stage === undefined) throw new DomainError('NOT_FOUND', 404);
    const steps = await this.stepsOf(playbookId, stage.stageKey);
    const rows = (await this.route.listItems(teamId, stageId)).filter(
      (r) => r.required && r.status === 'done' && steps.get(r.stepKey)?.reviewChecklist === true,
    );
    const ids = rows.map((r) => r.id);
    const [answers, risks] = await Promise.all([
      this.route.listReviewAnswers(ids),
      this.route.listReviewRisks(ids),
    ]);
    return rows
      .filter((row) => {
        const count = steps.get(row.stepKey)?.reviewItems.length ?? 0;
        const points = Array.from({ length: count }, (_, index) => ({
          answer:
            answers.find((a) => a.checklistItemId === row.id && a.ordinal === index + 1)?.answer ??
            null,
          riskAccepted: risks.some((r) => r.checklistItemId === row.id && r.ordinal === index + 1),
        }));
        return !isReviewPassed(points);
      })
      .map((r) => r.stepKey)
      .sort();
  }

  private async guarded(teamId: string, itemId: string, work: () => Promise<void>): Promise<void> {
    try {
      await this.tx.run(work);
    } catch (error) {
      if (error instanceof VersionConflict) throw await this.gate.conflict(teamId, itemId);
      throw error;
    }
  }

  private async submitInTx(
    userId: string,
    teamId: string,
    itemId: string,
    body: Body<'submitReview'>,
  ): Promise<void> {
    const { team, item, stage } = await this.gate.open(teamId, itemId, { member: userId });
    if (item.version !== body.version) throw new VersionConflict();
    const step = await this.reviewStep(team.playbookId, stage.stageKey, item);
    const uploaders = await this.reviews.fileUploaders(itemId);
    if (authorsOf({ ...item, fileUploaders: uploaders }).has(userId)) {
      throw new DomainError('REVIEW_OWN_ITEM', 403);
    }
    if (item.status !== 'done') throw new DomainError('INVALID_STATE', 409);
    const ordinals = body.answers.map((a) => a.ordinal);
    if (
      unknownOrdinals(step.reviewItems.length, ordinals).length > 0 ||
      new Set(ordinals).size < ordinals.length
    ) {
      throw new DomainError('VALIDATION_FAILED', 422, {
        errors: [{ pointer: '/answers', message: 'Answer each existing review point once' }],
      });
    }
    const now = this.clock.now();
    await this.reviews.saveAnswers(itemId, userId, body.answers, now);
    await this.bump(teamId, item, body.version, now);
  }

  private async acceptInTx(
    leadId: string,
    teamId: string,
    itemId: string,
    body: Body<'acceptReviewRisk'>,
  ): Promise<void> {
    const { team, item, stage } = await this.gate.open(teamId, itemId, { lead: leadId });
    if (item.version !== body.version) throw new VersionConflict();
    const step = await this.reviewStep(team.playbookId, stage.stageKey, item);
    const reason = body.reason.trim();
    if (reason.length < REASON_MIN) {
      throw new DomainError('VALIDATION_FAILED', 400, {
        errors: [{ pointer: '/reason', message: `At least ${REASON_MIN} characters` }],
      });
    }
    const answers = await this.reviews.answersOf(itemId);
    const given = answers.find((a) => a.ordinal === body.ordinal);
    if (
      unknownOrdinals(step.reviewItems.length, [body.ordinal]).length > 0 ||
      given?.answer !== false
    ) {
      throw new DomainError('VALIDATION_FAILED', 422, {
        errors: [{ pointer: '/ordinal', message: 'Only a point answered "no" can be accepted' }],
      });
    }
    const now = this.clock.now();
    await this.reviews.acceptRisk(itemId, body.ordinal, reason, leadId, now);
    await this.bump(teamId, item, body.version, now);
  }

  /** The review is part of the item: its version moves and the clients get one event. */
  private async bump(teamId: string, item: ItemRow, version: number, now: Date): Promise<void> {
    const row = await this.items.updateIfVersion(item.id, version, {}, now);
    if (row === undefined) throw new VersionConflict();
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'item_updated',
      aggregateId: item.id,
      payload: { teamId, itemId: item.id, version: row.version },
    });
  }

  private async reviewStep(
    playbookId: PlaybookId,
    stageKey: string,
    item: ItemRow,
  ): Promise<StepDefinition> {
    const step = (await this.stepsOf(playbookId, stageKey)).get(item.stepKey);
    if (step === undefined || !step.reviewChecklist || step.reviewItems.length === 0) {
      throw new DomainError('INVALID_STATE', 409, { detail: 'The item has no review checklist' });
    }
    return step;
  }

  private async stepsOf(
    playbookId: PlaybookId,
    stageKey: string,
  ): Promise<Map<string, StepDefinition>> {
    const definition = await this.playbooks.getDefinition(playbookId);
    const stage = definition.stages.find((s) => s.key === stageKey);
    return new Map((stage?.steps ?? []).map((s) => [s.key, s]));
  }
}
