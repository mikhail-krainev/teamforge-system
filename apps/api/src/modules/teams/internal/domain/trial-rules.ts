/** What the trial rules need to know about a membership. */
export interface TrialFacts {
  joinedVia: string;
  trialUntil: Date | null;
  trialConfirmedAt: Date | null;
}

/** Whether the member is still in the trial: not confirmed and the end lies ahead (FR-TEAM-22). */
export function isInTrial(facts: TrialFacts, now: Date): boolean {
  return (
    facts.trialConfirmedAt === null &&
    facts.trialUntil !== null &&
    facts.trialUntil.getTime() > now.getTime()
  );
}

export type TrialRefusal = 'NOT_AUTO_ADDED' | 'TRIAL_EXPIRED';

/** `undefined` when the member may still be excluded or confirmed. */
export function trialRefusal(facts: TrialFacts, now: Date): TrialRefusal | undefined {
  if (facts.joinedVia !== 'auto') return 'NOT_AUTO_ADDED';
  return isInTrial(facts, now) ? undefined : 'TRIAL_EXPIRED';
}

/** The trial of an auto-added member has run out and nobody confirmed it (the timer's work). */
export function trialRanOut(facts: TrialFacts, now: Date): boolean {
  return (
    facts.joinedVia === 'auto' &&
    facts.trialConfirmedAt === null &&
    facts.trialUntil !== null &&
    facts.trialUntil.getTime() <= now.getTime()
  );
}
