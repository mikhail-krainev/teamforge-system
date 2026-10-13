/** Pure rules of the lead's decision after a member left (FR-TEAM-12, C-14). */

/** C-14: a decision nobody took in 7 days becomes "replace". */
export const DEPARTURE_DEFAULT_MS = 7 * 24 * 3_600_000;

export function departureDueAt(leftAt: Date): Date {
  return new Date(leftAt.getTime() + DEPARTURE_DEFAULT_MS);
}

/** The default is only applied once the term has really passed (a timer can fire early after a clock change). */
export function departureOverdue(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() <= now.getTime();
}

export interface DepartureDecisionInput {
  decision: 'replace' | 'continue';
  closeSeatIds?: string[] | undefined;
}

/**
 * `closeSeatIds` only makes sense with "continue" and only for seats this departure freed.
 * Returns the offending request pointer, or `undefined` when the request is consistent.
 */
export function decisionPointerError(
  input: DepartureDecisionInput,
  departureSeatIds: readonly string[],
): string | undefined {
  const close = input.closeSeatIds ?? [];
  if (input.decision === 'replace') return close.length > 0 ? '/closeSeatIds' : undefined;
  return close.every((id) => departureSeatIds.includes(id)) ? undefined : '/closeSeatIds';
}
