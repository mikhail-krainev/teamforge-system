/** Ids of the outbox events a plan wrote; the processor hands them to their consumers when it has committed. */
export type EventIds = string[];

/**
 * What a handler decided about a delivery before the transaction: nothing to do (`ignore`), or the
 * writes (`apply`) that the processor runs under the lock of the delivery row. Everything that waits
 * for another system (GitHub, other modules) happens while the plan is made, never inside `run`.
 */
export type DeliveryPlan = { kind: 'ignore' } | { kind: 'apply'; run: () => Promise<EventIds> };

export const IGNORE: DeliveryPlan = { kind: 'ignore' };

export const apply = (run: () => Promise<EventIds>): DeliveryPlan => ({ kind: 'apply', run });
