/**
 * Thresholds of the anti-fraud rules (docs/spec.md 7 and 8). The thresholds of the block rules AF-04, AF-09 and
 * AF-10 (10 items, 2 accounts, 14 days, 3 calendar days, 24 hours per stage) live in the workspace module and are
 * reused from `workspace/public.ts`, so the completion and the safety net in rewards cannot disagree.
 */

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * HOUR_MS;

/** C-61: a sum of `signal` scores at or above this freezes the project (FR-REW-15). */
export const SCORE_THRESHOLD = 3;
/** C-55 (AF-03): the repository is older than the start of the project by more than this many days. */
export const REPO_AGE_DAYS = 30;
/** AF-05: fewer changed lines in merged pull requests than this. */
export const MIN_CHANGED_LINES = 200;
/** AF-05: one pull request holds more than this share of the changes. */
export const MAX_PR_SHARE = 0.8;
/** AF-07: the last hours of the project in which a late burst of events is counted. */
export const LATE_WINDOW_HOURS = 48;
/** AF-07: more than this share of the events falls into the late window. */
export const LATE_SHARE = 0.7;
/** AF-11: the project is completed sooner than this many hours after the team was created. */
export const MIN_TEAM_AGE_HOURS = 24;
/** AF-11: all stages closed in less than this share of their planned length. */
export const MIN_PLAN_SHARE = 0.2;
/** AF-12: this many stages closed within `STAGE_BURST_MINUTES` give +1. */
export const STAGE_BURST_COUNT = 3;
export const STAGE_BURST_MINUTES = 60;
/** AF-13: a roster of at least this many people (+1 at 2 projects, flag at 3). */
export const MIN_ROSTER = 3;
export const ROSTER_SIGNAL_PROJECTS = 2;
export const ROSTER_FLAG_PROJECTS = 3;
/** C-17 (AF-14): a mark set fewer days before the completion gives +1. */
export const DESIRED_MARK_DAYS = 7;
/** C-59 (AF-16): the GitHub account is at least this many days old. */
export const ACCOUNT_MIN_AGE_DAYS = 30;
/** AF-17: members sharing a value of one kind: 2 give +1, 3 or more +2. */
export const SHARED_PAIR = 2;
export const SHARED_GROUP = 3;
/** AF-19: registrations or joinings this close (minutes) are suspicious. */
export const CLOSE_MINUTES = 10;
/** AF-21: features in common (network, device, text) that link two accounts. */
export const LINK_FEATURES = 3;
/** AF-22: from this score on, one credited project per `CREDIT_GAP_DAYS` is allowed. */
export const MIN_SCORE_FOR_LIMIT = 2;
export const CREDIT_GAP_DAYS = 14;

/** Scores of the `signal` rules (docs/spec.md 8). */
export const SCORE = {
  AF08: 1,
  AF12: 1,
  AF13: 1,
  AF14: 1,
  AF15: 1,
  AF17_PAIR: 1,
  AF17_GROUP: 2,
  AF18: 2,
  AF19: 1,
  AF20: 2,
} as const;
