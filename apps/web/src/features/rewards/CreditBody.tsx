'use client';

import type { CreditStatus } from './api';
import { StatusBlock, MyCredits } from './CreditParts';
import { DisputeSection } from './DisputeForm';
import { isCoolingOpen } from './model';

/** Status, own credits and, inside the cooling window of a not yet decided project, the complaint. */
export function CreditParts({
  teamId,
  credit,
  now,
  roleName,
}: {
  teamId: string;
  credit: CreditStatus;
  now: Date;
  roleName: (code: string) => string;
}) {
  const undecided = credit.status === 'cooling' || credit.status === 'frozen';
  const canDispute = undecided && isCoolingOpen(credit.coolingUntil, now);
  return (
    <>
      <StatusBlock credit={credit} now={now} />
      <MyCredits rows={credit.myCredits} roleName={roleName} />
      {canDispute ? <DisputeSection teamId={teamId} /> : null}
    </>
  );
}
