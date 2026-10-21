'use client';

import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import type { Member } from '@/features/teams/api';
import type { ContributionSummary as Summary } from './api';
import { memberNameOf, type RoleNameOf } from './model';
import { useContributionSummary } from './queries';

interface Props {
  teamId: string;
  members: readonly Pick<Member, 'userId' | 'displayName'>[];
  roleName: RoleNameOf;
}

function SummaryTable({
  summary,
  members,
  roleName,
}: Omit<Props, 'teamId'> & { summary: Summary }) {
  const nameOf = memberNameOf(members);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="sr-only">{t('feed.summary.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('feed.summary.member')}</th>
            <th scope="col">{t('feed.summary.role')}</th>
            <th scope="col">{t('feed.summary.issues')}</th>
            <th scope="col">{t('feed.summary.prs')}</th>
            <th scope="col">{t('feed.summary.artifacts')}</th>
            <th scope="col">{t('feed.summary.rituals')}</th>
          </tr>
        </thead>
        <tbody>
          {summary.members.flatMap((member) =>
            member.byRole.map((row) => (
              <tr key={`${member.userId}:${row.roleCode}`}>
                <th scope="row">{nameOf(member.userId)}</th>
                <td>{roleName(row.roleCode)}</td>
                <td>{row.issues}</td>
                <td>{row.prs}</td>
                <td>{row.artifacts}</td>
                <td>{row.rituals}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Contributions of every participant by role (FR-WORK-16), refreshed with the feed. */
export function ContributionSummary({ teamId, members, roleName }: Props) {
  const query = useContributionSummary(teamId);
  const summary = query.data;
  const rows = summary?.members.flatMap((member) => member.byRole) ?? [];
  return (
    <section className="stack" aria-labelledby="contribution-summary-title">
      <h2 id="contribution-summary-title">{t('feed.summary.title')}</h2>
      {query.isPending ? <p role="status">{t('feed.summary.loading')}</p> : null}
      {query.isError ? (
        <Alert tone="error">
          <p>{t('feed.summary.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void query.refetch()}
          >
            {t('feed.retry')}
          </button>
        </Alert>
      ) : null}
      {summary && rows.length === 0 ? <p className="muted">{t('feed.summary.empty')}</p> : null}
      {summary && rows.length > 0 ? (
        <SummaryTable summary={summary} members={members} roleName={roleName} />
      ) : null}
      {summary && summary.unassignedItemIds.length > 0 ? (
        <p className="muted">
          {t('feed.summary.unassigned', { count: summary.unassignedItemIds.length })}
        </p>
      ) : null}
    </section>
  );
}
