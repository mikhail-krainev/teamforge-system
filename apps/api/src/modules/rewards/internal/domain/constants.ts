export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** C-17b: the credit is applied this long after the completion. */
export const COOLING_MS = 7 * DAY_MS;
/** C-60: the share of the stages a person must take part in (percent, rounded up). */
export const STAGE_SHARE_PERCENT = 60;
/** The scanners: a completion younger than this is left to the event; they look this far back. */
export const SCAN_AGE_MS = 10 * 60_000;
export const SCAN_WINDOW_MS = 30 * DAY_MS;
/** C-64: how long the HMACs of the sign-in are kept, so how far back the rules look at them. */
export const IDENTITY_WINDOW_MS = 90 * DAY_MS;

/** `credit_run.status` and the statuses of a person's credit. */
export type RunStatus = 'cooling' | 'frozen' | 'credited' | 'revoked';
export type ItemStatus = 'credited' | 'pending_account' | 'denied' | 'revoked';

/** Reasons stored in `project_credit.reason` (shown to the person, no signal of the anti-fraud among them). */
export const REASON = {
  noContribution: 'NO_CONTRIBUTION',
  tooFewStages: 'TOO_FEW_STAGES',
  accountNotChecked: 'ACCOUNT_NOT_CHECKED',
} as const;

/** Codes of the seed of `rewards.badge_def` (migration 0019). */
export const BADGE = {
  onTime: 'on_time',
  streak: 'on_time_streak',
  deficit: 'closed_deficit',
  vacancy: 'closed_vacancy',
} as const;

/** FR-REW-05: the steps of the series and the number that reaches each. */
export const SERIES_STEPS = {
  projects: [
    { code: 'projects_1', at: 1 },
    { code: 'projects_2', at: 3 },
    { code: 'projects_3', at: 5 },
    { code: 'projects_4', at: 10 },
  ],
  roles: [
    { code: 'roles_1', at: 3 },
    { code: 'roles_2', at: 5 },
  ],
  product_types: [
    { code: 'product_types_1', at: 2 },
    { code: 'product_types_2', at: 4 },
  ],
} as const;

/** The three last credited projects without delay make the streak (FR-REW-08). */
export const STREAK_LENGTH = 3;
