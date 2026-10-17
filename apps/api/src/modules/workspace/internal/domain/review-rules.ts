/** A review point as stored: the reviewer's answer and, for a "no", the risk the lead accepted. */
export interface PointState {
  answer: boolean | null;
  riskAccepted: boolean;
}

/**
 * FR-WORK-09: the review is passed when it has points and every one is answered "yes" or is a "no"
 * (or still unanswered) whose risk the lead accepted. A point nobody answered blocks the review.
 */
export function isReviewPassed(points: PointState[]): boolean {
  return points.length > 0 && points.every((p) => p.answer === true || p.riskAccepted);
}

/** The ordinals (1-based) of the review points of a step that exist. */
export function unknownOrdinals(pointCount: number, ordinals: number[]): number[] {
  return ordinals.filter((o) => !Number.isInteger(o) || o < 1 || o > pointCount);
}

/** Who may not review: the executor, the one who closed the item, and every uploader of its files. */
export function authorsOf(item: {
  assigneeUserId: string | null;
  doneBy: string | null;
  fileUploaders: string[];
}): Set<string> {
  const authors = new Set<string>(item.fileUploaders);
  if (item.assigneeUserId !== null) authors.add(item.assigneeUserId);
  if (item.doneBy !== null) authors.add(item.doneBy);
  return authors;
}
