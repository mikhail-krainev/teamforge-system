import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import type { ChecklistItem, ProjectStage } from '@/features/route/api';

/** C-08: an open stage cannot be closed earlier than this many hours after it opened. */
export const MIN_STAGE_HOURS = 24;
const HOUR_MS = 3_600_000;

export interface UnmetEntry {
  code: string;
  /** The server's own wording; used only for a code this client does not know yet. */
  message?: string | undefined;
}

interface LocalInput {
  stage: Pick<ProjectStage, 'openedAt'>;
  items: readonly ChecklistItem[];
  /** Step keys of the stage that have a review checklist in the playbook. */
  reviewKeys: ReadonlySet<string>;
  now: Date;
}

/**
 * A hint about what blocks the transition, computed from what the page shows (FR-WORK-10). The
 * server checks again inside the transaction and its answer (`unmet[]`) replaces this list.
 */
export function localUnmet({ stage, items, reviewKeys, now }: LocalInput): UnmetEntry[] {
  const required = items.filter((item) => item.required);
  const unmet: UnmetEntry[] = [];
  if (required.some((item) => item.status === 'open')) {
    unmet.push({ code: 'REQUIRED_ITEMS_OPEN' });
  }
  if (required.some((item) => item.fallbackUsed && item.assigneeUserId === null)) {
    unmet.push({ code: 'FALLBACK_ASSIGNEE_MISSING' });
  }
  if (required.some((item) => reviewKeys.has(item.stepKey) && item.review?.passed !== true)) {
    unmet.push({ code: 'REVIEW_NOT_PASSED' });
  }
  const openedAt = stage.openedAt ? new Date(stage.openedAt).getTime() : null;
  if (openedAt !== null && now.getTime() < openedAt + MIN_STAGE_HOURS * HOUR_MS) {
    unmet.push({ code: 'MIN_TIME_NOT_ELAPSED' });
  }
  return unmet;
}

/** `unmet[]` of a 409 STAGE_TRANSITION_BLOCKED, or `null` for any other error. */
export function unmetFromError(error: unknown): UnmetEntry[] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409 || error.code !== 'STAGE_TRANSITION_BLOCKED') return null;
  return (error.problem?.unmet ?? []).map((entry) => ({
    code: entry.code,
    message: entry.message,
  }));
}

export function unmetText(entry: UnmetEntry): string {
  const key = `transition.unmet.${entry.code}`;
  if (hasMessage(key)) return t(key);
  return entry.message ?? t('transition.unmet.unknown');
}

export function isStageNotOpen(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'STAGE_NOT_OPEN';
}

/** Russian text of a failed transition that is not a list of unmet conditions. */
export function transitionErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `transition.errors.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return t('transition.errors.unknown');
}
