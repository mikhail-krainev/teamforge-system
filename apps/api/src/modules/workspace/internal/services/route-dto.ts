import type { Schema } from 'shared';
import type { StepDefinition } from '../../../playbooks/public.js';
import { isReviewPassed } from '../domain/review-rules.js';
import { effectiveDueAt, isOverdue, stageSuspensionMs } from '../domain/route-plan.js';
import type {
  FileRow,
  ItemRow,
  ReviewAnswerRow,
  ReviewRiskRow,
  StageRow,
} from '../repositories/route.repository.js';

export type ProjectStageDto = Schema<'ProjectStage'>;
export type ChecklistItemDto = Schema<'ChecklistItem'>;
type ArtifactFileDto = Schema<'ArtifactFile'>;
type ReviewStateDto = Schema<'ReviewState'>;

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value === null ? null : iso(value));

/** A stage of the route with its dates; the suspension facts and `plannedEndAt` come from the team (FR-WORK-12, -18). */
export function toStageDto(
  row: StageRow,
  context: {
    now: Date;
    team: { status: string; suspendedAt: Date | null; suspendedTotalSeconds: number };
    plannedEndAt: Date | null;
  },
): ProjectStageDto {
  const due = effectiveDueAt(
    row,
    stageSuspensionMs(context.team, row.suspendedAppliedSeconds, context.now),
  );
  return {
    ordinal: row.ordinal,
    key: row.stageKey,
    title: row.title,
    status: row.status as ProjectStageDto['status'],
    durationDays: row.durationDays,
    openedAt: isoOrNull(row.openedAt),
    dueAt: isoOrNull(due),
    closedAt: isoOrNull(row.closedAt),
    overdue: isOverdue(row, due, context.plannedEndAt, context.now),
  };
}

export function toFileDto(row: FileRow): ArtifactFileDto {
  return {
    id: row.id,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    mime: row.mime,
    sha256: row.sha256.toString('hex'),
    uploadedBy: row.uploadedBy,
    createdAt: iso(row.createdAt),
  };
}

export interface ReviewFacts {
  answers: ReviewAnswerRow[];
  risks: ReviewRiskRow[];
}

/** The review of an item whose step has review points (Р-3: points belong to the step). */
export function toReviewDto(step: StepDefinition, facts: ReviewFacts): ReviewStateDto | null {
  if (!step.reviewChecklist) return null;
  const answers = step.reviewItems.map((text, index) => {
    const ordinal = index + 1;
    const given = facts.answers.find((a) => a.ordinal === ordinal);
    const risk = facts.risks.find((r) => r.ordinal === ordinal);
    return {
      ordinal,
      text,
      answer: given?.answer ?? null,
      acceptedRisk:
        risk === undefined
          ? null
          : { reason: risk.reason, acceptedBy: risk.acceptedBy, at: iso(risk.acceptedAt) },
    };
  });
  return {
    reviewerUserId: facts.answers[0]?.reviewerUserId ?? null,
    answers,
    passed: isReviewPassed(
      answers.map((a) => ({ answer: a.answer, riskAccepted: a.acceptedRisk !== null })),
    ),
  };
}

export function toItemDto(
  row: ItemRow,
  context: {
    stageOrdinal: number;
    step: StepDefinition | undefined;
    files: FileRow[];
    review: ReviewFacts;
  },
): ChecklistItemDto {
  const { step } = context;
  return {
    id: row.id,
    stageOrdinal: context.stageOrdinal,
    stepKey: row.stepKey,
    title: step?.title ?? row.stepKey,
    kind: row.kind as ChecklistItemDto['kind'],
    submission: row.submission as ChecklistItemDto['submission'],
    ritualKind: row.ritualKind as ChecklistItemDto['ritualKind'],
    required: row.required,
    ownerRole: row.ownerRole,
    status: row.status as ChecklistItemDto['status'],
    assigneeUserId: row.assigneeUserId,
    roleCode: row.roleCode,
    fallbackUsed: row.fallbackUsed,
    fallback: row.fallbackUsed && step?.fallback ? step.fallback : null,
    linkUrl: row.linkUrl,
    linkStatus: row.linkStatus as ChecklistItemDto['linkStatus'],
    heldOn: row.heldOn,
    externalUrl: row.externalUrl,
    outcome: row.outcome,
    files: context.files.map(toFileDto),
    review: step === undefined ? null : toReviewDto(step, context.review),
    version: row.version,
    updatedAt: iso(row.updatedAt),
  };
}
