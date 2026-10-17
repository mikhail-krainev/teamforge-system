import type { UnmetCondition } from '../../../../platform/errors/domain-error.js';

/** C-08, AF-10: a stage cannot be closed sooner than this after it opened. */
export const MIN_STAGE_MS = 24 * 3_600_000;

/** The facts of an item the transition looks at. */
export interface TransitionItem {
  id: string;
  stepKey: string;
  required: boolean;
  status: string;
  fallbackUsed: boolean;
  assigneeUserId: string | null;
}

export interface TransitionFacts {
  items: readonly TransitionItem[];
  /** Step keys of the done, required items whose review is not passed (S5-07). */
  unpassedStepKeys: readonly string[];
  openedAt: Date | null;
  now: Date;
}

/**
 * The conditions of closing a stage (architecture 11.3, FR-WORK-10), in the order of the contract's
 * `UnmetCode`. Being late is not a condition. The automatic checks (`AUTO_CHECKS_FAILED`) join in S5-09.
 */
export function unmetConditions(facts: TransitionFacts): UnmetCondition[] {
  const unmet: UnmetCondition[] = [];
  const required = facts.items.filter((i) => i.required);
  const open = required.filter((i) => i.status !== 'done');
  if (open.length > 0) {
    unmet.push({
      code: 'REQUIRED_ITEMS_OPEN',
      message: 'Не закрыты обязательные пункты этапа',
      data: { itemIds: open.map((i) => i.id), stepKeys: open.map((i) => i.stepKey) },
    });
  }
  const orphans = open.filter((i) => i.fallbackUsed && i.assigneeUserId === null);
  if (orphans.length > 0) {
    unmet.push({
      code: 'FALLBACK_ASSIGNEE_MISSING',
      message: 'Назначьте исполнителя запасного шага',
      data: { itemIds: orphans.map((i) => i.id), stepKeys: orphans.map((i) => i.stepKey) },
    });
  }
  if (facts.unpassedStepKeys.length > 0) {
    const keys = new Set(facts.unpassedStepKeys);
    const items = required.filter((i) => keys.has(i.stepKey));
    unmet.push({
      code: 'REVIEW_NOT_PASSED',
      message: 'Ревью не пройдено: ответьте на все вопросы или примите риск',
      data: { itemIds: items.map((i) => i.id), stepKeys: [...keys] },
    });
  }
  const elapsed = facts.openedAt === null ? 0 : facts.now.getTime() - facts.openedAt.getTime();
  if (facts.openedAt === null || elapsed < MIN_STAGE_MS) {
    const earliest =
      facts.openedAt === null ? null : new Date(facts.openedAt.getTime() + MIN_STAGE_MS);
    unmet.push({
      code: 'MIN_TIME_NOT_ELAPSED',
      message: 'Этап идёт меньше 24 часов',
      data: { earliestAt: earliest?.toISOString() ?? null },
    });
  }
  return unmet;
}

/** The next stage after `from` (the strict order of FR-WORK-10), or none after the last. */
export function nextOrdinal(ordinals: readonly number[], from: number): number | undefined {
  return ordinals.filter((o) => o > from).sort((a, b) => a - b)[0];
}

/** Stages of a project whose end is near: the timer `stage-due-notify` tells the team (FR-WORK-19). */
export const STAGE_DUE_SOON_MS = 24 * 3_600_000;

export type StageDuePhase = 'soon' | 'overdue';

/** `null` while there is time; a suspended team is frozen (FR-WORK-18) and never asks. */
export function stageDuePhase(dueAt: Date, now: Date, teamStatus: string): StageDuePhase | null {
  if (teamStatus === 'suspended') return null;
  const left = dueAt.getTime() - now.getTime();
  if (left <= 0) return 'overdue';
  return left <= STAGE_DUE_SOON_MS ? 'soon' : null;
}
