export interface MergedPull {
  number: number;
  authorGithubId: number | null;
}

export interface ReviewFact {
  prNumber: number;
  reviewerGithubId: number;
  /** Lower case, as `gh_pr_review.state` keeps it. */
  state: string;
}

/** A review that is not a draft of one or one that was withdrawn. */
const COUNTED_STATES = new Set(['approved', 'changes_requested', 'commented']);

/**
 * `pr_cross_review:N`: how many merged pull requests have a review by somebody who is not their author.
 * The author reviewing their own pull request does not count.
 */
export function crossReviewedPullCount(
  pulls: readonly MergedPull[],
  reviews: readonly ReviewFact[],
): number {
  return pulls.filter((pull) =>
    reviews.some(
      (review) =>
        review.prNumber === pull.number &&
        review.reviewerGithubId !== pull.authorGithubId &&
        COUNTED_STATES.has(review.state),
    ),
  ).length;
}
