'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useRoles } from '@/features/profile/useProfileQueries';
import { useNow } from '@/features/completion/useNow';
import { isHiddenError } from '@/features/route/RouteStates';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { CreditParts } from './CreditBody';
import { useCredit } from './queries';

const TICK_MS = 30_000;

/** `/teams/[id]/credit`: the status of the credit of a finished project and the own credits by role. */
export function CreditPage({ teamId }: { teamId: string }) {
  const credit = useCredit(teamId);
  const roles = useRoles();
  const now = useNow(TICK_MS);

  if (credit.isPending) return <p role="status">{t('rewards.credit.loading')}</p>;
  if (credit.isError) {
    const hidden = isHiddenError(credit.error);
    return (
      <Alert tone="error">
        <p>{hidden ? t('rewards.credit.notFound') : t('rewards.credit.loadFailed')}</p>
        {hidden ? null : <p className="muted">{describeError(credit.error)}</p>}
        {hidden ? null : (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void credit.refetch()}
          >
            {t('rewards.credit.retry')}
          </button>
        )}
      </Alert>
    );
  }
  const roleName = (code: string) => roles.data?.find((role) => role.code === code)?.name ?? code;
  return (
    <div className="stack">
      <h1>{t('rewards.credit.title')}</h1>
      <p className="row">
        <Link href={`/teams/${teamId}`}>{t('rewards.credit.back')}</Link>
        <Link href="/reviews">{t('rewards.credit.reviewsLink')}</Link>
      </p>
      <CreditParts teamId={teamId} credit={credit.data} now={now} roleName={roleName} />
    </div>
  );
}
