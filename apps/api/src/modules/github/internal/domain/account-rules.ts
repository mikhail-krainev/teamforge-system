const DAY_MS = 24 * 60 * 60 * 1000;
/** C-59 (FR-GH-09): the youngest GitHub account that earns a credit. */
export const MIN_ACCOUNT_AGE_DAYS = 30;

export type AccountReason = 'ACCOUNT_TOO_YOUNG' | 'ACCOUNT_NO_PUBLIC_ACTIVITY';

export interface AccountFacts {
  accountCreatedAt: Date;
  publicRepos: number;
  hasPublicActivity: boolean;
}

export interface AccountVerdict {
  /** False: the credit waits (`pending_account`), it is not refused (FR-GH-09). */
  eligible: boolean;
  reasons: AccountReason[];
}

/** FR-GH-09: the account is at least 30 days old and has a public repository or public activity. */
export function evaluateAccount(facts: AccountFacts, now: Date): AccountVerdict {
  const reasons: AccountReason[] = [];
  if (now.getTime() - facts.accountCreatedAt.getTime() < MIN_ACCOUNT_AGE_DAYS * DAY_MS) {
    reasons.push('ACCOUNT_TOO_YOUNG');
  }
  if (facts.publicRepos <= 0 && !facts.hasPublicActivity) {
    reasons.push('ACCOUNT_NO_PUBLIC_ACTIVITY');
  }
  return { eligible: reasons.length === 0, reasons };
}
