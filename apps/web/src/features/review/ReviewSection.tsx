'use client';

import { useState } from 'react';
import { t } from '@/i18n';
import type { ChecklistItem } from '@/features/route/api';
import type { ItemWrites } from '@/features/checklist/useItemWrites';
import { ReviewForm } from './ReviewForm';
import { RiskForm } from './RiskForm';

type ReviewState = NonNullable<ChecklistItem['review']>;

interface Props {
  item: ChecklistItem;
  writes: ItemWrites;
  /** Review questions of the playbook step; empty when the step has no review checklist. */
  points: readonly string[];
  meId: string;
  isLead: boolean;
  editable: boolean;
}

function answerText(answer: boolean | null): string {
  if (answer === null) return t('review.answerNone');
  return t(answer ? 'review.answerYes' : 'review.answerNo');
}

function Answers({
  review,
  canAccept,
  onAccept,
}: {
  review: ReviewState;
  canAccept: boolean;
  onAccept: (ordinal: number) => void;
}) {
  return (
    <ul className="stack" aria-label={t('review.answers')}>
      {review.answers.map((entry) => (
        <li key={entry.ordinal} className="stack">
          <span>
            {t('review.answerLine', { text: entry.text, answer: answerText(entry.answer) })}
          </span>
          {entry.acceptedRisk ? (
            <span className="muted">
              {t('review.riskAccepted', { reason: entry.acceptedRisk.reason })}
            </span>
          ) : null}
          {canAccept && entry.answer === false && !entry.acceptedRisk ? (
            <span>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => onAccept(entry.ordinal)}
              >
                {t('review.acceptRisk')}
              </button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ReviewResult({
  review,
  canAccept,
  onAccept,
}: {
  review: ReviewState;
  canAccept: boolean;
  onAccept: (ordinal: number) => void;
}) {
  // No answer at all is "not started", not a failed review: the verdict appears with the first answer.
  const started = review.answers.some((entry) => entry.answer !== null);
  const verdict = review.passed
    ? 'review.passed'
    : started
      ? 'review.notPassed'
      : 'review.notStarted';
  return (
    <>
      <p>
        <strong>{t(verdict)}</strong>
      </p>
      <Answers review={review} canAccept={canAccept} onAccept={onAccept} />
    </>
  );
}

type Mode = { kind: 'form' } | { kind: 'risk'; ordinal: number } | null;

function ModeForms({
  mode,
  review,
  points,
  writes,
  close,
}: {
  mode: Mode;
  review: ReviewState | null;
  points: readonly string[];
  writes: ItemWrites;
  close: () => void;
}) {
  if (mode?.kind === 'form') {
    return (
      <ReviewForm
        points={points}
        pending={writes.pending}
        onCancel={close}
        onSubmit={(answers) =>
          void writes.submit({ kind: 'review', answers }).then((ok) => ok && close())
        }
      />
    );
  }
  const point =
    mode?.kind === 'risk' ? review?.answers.find((a) => a.ordinal === mode.ordinal) : undefined;
  if (!point) return null;
  return (
    <RiskForm
      pointText={point.text}
      pending={writes.pending}
      onCancel={close}
      onSubmit={(reason) =>
        void writes
          .submit({ kind: 'risk', ordinal: point.ordinal, reason })
          .then((ok) => ok && close())
      }
    />
  );
}

/**
 * Review of an item (FR-WORK-09): the result and answers, the form for a reviewer who is not
 * the executor, and, for the lead, accepting a "no" answer as a written risk.
 */
export function ReviewSection({ item, writes, points, meId, isLead, editable }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const review = item.review ?? null;
  if (points.length === 0 && !review) return null;

  const isExecutor = item.assigneeUserId === meId;
  const reviewable = points.length > 0 && review?.passed !== true;
  const canReview = editable && !isExecutor && reviewable;
  return (
    <section className="stack">
      {review ? (
        <ReviewResult
          review={review}
          canAccept={isLead && editable && !review.passed}
          onAccept={(ordinal) => setMode({ kind: 'risk', ordinal })}
        />
      ) : null}
      {isExecutor && reviewable ? <p className="muted">{t('review.ownItem')}</p> : null}
      {canReview && mode === null ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setMode({ kind: 'form' })}
          >
            {t('review.open')}
          </button>
        </div>
      ) : null}
      <ModeForms
        mode={mode}
        review={review}
        points={points}
        writes={writes}
        close={() => setMode(null)}
      />
    </section>
  );
}
