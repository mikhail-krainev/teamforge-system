import { z } from 'zod';

/**
 * What crosses the `link-check` queue (architecture 13.12). The link-checker has no database, so a job
 * carries the address to check and the ids the answer is applied to; the answer is a code and a status.
 * Shared by the producer in the workspace module and the consumer in the link-checker process.
 */

export const LINK_CHECK_QUEUE = 'link-check' as const;
export const CHECK_ITEM_LINK_JOB = 'check-item-link' as const;

/** A link longer than this is never stored (the column and the contract bound it), so never queued. */
const MAX_URL_LENGTH = 2048;

export const linkCheckJobSchema = z.object({
  teamId: z.uuid(),
  itemId: z.uuid(),
  /** Version of the item when the link was saved; the answer is applied only if the link is still the same. */
  version: z.number().int().positive(),
  url: z.string().min(1).max(MAX_URL_LENGTH),
  requestId: z.string().optional(),
  /** When the link was saved (the clock of the application); echoed in the answer, which may come later. */
  savedAt: z.iso.datetime().optional(),
  /** Set by the consumer when the check first met a busy domain (`Date.now()`); the limit on waiting counts from it. */
  firstBusyAt: z.number().int().positive().optional(),
});
export type LinkCheckJobData = z.infer<typeof linkCheckJobSchema>;

const reasonSchema = z.enum([
  'HTTP_STATUS',
  'TOO_SMALL',
  'PLACEHOLDER_TITLE',
  'TIMEOUT',
  'BLOCKED_ADDRESS',
  'BLOCKED_PORT',
  'TLS_ERROR',
  'TOO_MANY_REDIRECTS',
  'DNS_ERROR',
]);

export const linkCheckResultSchema = z.object({
  teamId: z.uuid(),
  itemId: z.uuid(),
  version: z.number().int().positive(),
  url: z.string(),
  savedAt: z.iso.datetime().optional(),
  outcome: z.object({
    ok: z.boolean(),
    reason: reasonSchema.nullable(),
    httpStatus: z.number().int().nullable(),
  }),
});
export type LinkCheckResult = z.infer<typeof linkCheckResultSchema>;

/** The BullMQ job id of a check of one saved link. */
export function linkCheckJobId(itemId: string, version: number, round = 0): string {
  const base = `item-link_${itemId}_${version}`;
  return round === 0 ? base : `${base}_${round}`;
}
