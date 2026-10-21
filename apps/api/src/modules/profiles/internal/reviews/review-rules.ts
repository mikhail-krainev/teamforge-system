import { jobId } from '../../../../platform/queues/job-id.js';

const DAY_MS = 86_400_000;

/** C-27: reviews are written this long after the completion of the project. */
export const REVIEW_WINDOW_MS = 14 * DAY_MS;

/** SEC-04: a subject sees a batch only when at least this many people wrote about him. */
export const MIN_REVIEW_AUTHORS = 2;

/** A withheld review is deleted this many days after the window closed. */
export const WITHHELD_RETENTION_DAYS = 30;

/** Job of the `timers` queue that publishes (or withholds) the reviews of one team. */
export const REVIEW_PUBLISH_JOB = 'review-publish';

/** Deterministic id: scheduling the same team twice adds nothing. */
export const reviewPublishJobId = (teamId: string): string => jobId('reviewpublish', teamId);

/** The end of the review window of a project completed at `completedAt`. */
export const windowUntilOf = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + REVIEW_WINDOW_MS);

/** The UTC calendar day of a moment, `YYYY-MM-DD` (the date of a batch does not depend on the server zone). */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * SEC-04: the text of a review is shown escaped, so that markup written by a colleague never comes
 * back as markup. The stored text stays as it was written.
 */
export const escapeReviewText = (text: string): string =>
  text.replaceAll(/[&<>]/g, (char) => ESCAPES[char] ?? char);

/** Reads `{ teamId }` of a `review-publish` job. */
export function parseReviewPublish(data: unknown): string {
  const { teamId } = (data ?? {}) as { teamId?: unknown };
  if (typeof teamId !== 'string' || teamId === '') throw new Error('review-publish needs a teamId');
  return teamId;
}
