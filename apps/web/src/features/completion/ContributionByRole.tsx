'use client';

import { useContributionSummary } from '@/features/contribution/queries';
import { memberNameOf, totalsByRole } from '@/features/contribution/model';
import type { Team } from '@/features/teams/api';
import { t } from '@/i18n';

/** Contributions by role as they stand at completion (the roles are fixed then, FR-WORK-17). */
export function ContributionByRole({
  team,
  roleName,
}: {
  team: Team;
  roleName: (code: string) => string;
}) {
  const summary = useContributionSummary(team.id);
  const nameOf = memberNameOf(team.members);
  const totals = summary.data ? totalsByRole(summary.data) : [];
  return (
    <section className="stack" aria-labelledby="results-contributions">
      <h2 id="results-contributions">{t('completion.results.contributions')}</h2>
      {summary.isPending ? <p role="status">{t('completion.results.loading')}</p> : null}
      {summary.isError ? <p className="muted">{t('completion.results.loadFailed')}</p> : null}
      {summary.data && totals.length === 0 ? (
        <p className="muted">{t('completion.results.noContributions')}</p>
      ) : null}
      {totals.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">{t('completion.results.contributionsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('completion.results.role')}</th>
                <th scope="col">{t('completion.results.members')}</th>
                <th scope="col">{t('completion.results.issues')}</th>
                <th scope="col">{t('completion.results.prs')}</th>
                <th scope="col">{t('completion.results.artifacts')}</th>
                <th scope="col">{t('completion.results.rituals')}</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((row) => (
                <tr key={row.roleCode}>
                  <th scope="row">{roleName(row.roleCode)}</th>
                  <td>{row.userIds.map(nameOf).join(', ')}</td>
                  <td>{row.issues}</td>
                  <td>{row.prs}</td>
                  <td>{row.artifacts}</td>
                  <td>{row.rituals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
