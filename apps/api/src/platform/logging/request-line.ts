/**
 * Operations whose request line must not name the caller (FR-PROF-08, SEC-04): the author of a peer review is hidden
 * from every response, log and export, and a line "user X called createPeerReview at T" is exactly that link. The
 * other fields of the line (route, status, duration) stay, so the operation is still observable.
 */
export const ANONYMOUS_CALLER_OPERATIONS: ReadonlySet<string> = new Set([
  'createPeerReview',
  'listSentReviews',
]);

/** The `user_id` of the access log line: the caller, except for the operations that keep the caller anonymous. */
export function loggedUserId(context: {
  operationId?: string | undefined;
  userId?: string | undefined;
} | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context.operationId !== undefined && ANONYMOUS_CALLER_OPERATIONS.has(context.operationId)) {
    return undefined;
  }
  return context.userId;
}
