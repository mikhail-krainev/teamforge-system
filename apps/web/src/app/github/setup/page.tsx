import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui/Alert';
import { setupErrorText } from '@/features/github/errors';
import { parseInstallationId, parseSetupError } from '@/features/github/model';
import { t } from '@/i18n';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Param = string | string[] | undefined;
const first = (value: Param): string | undefined => (Array.isArray(value) ? value[0] : value);

interface Query {
  team?: Param;
  teamId?: Param;
  installation?: Param;
  installation_id?: Param;
  error?: Param;
}

/**
 * The page the browser returns to after GitHub (S6-09). The API has already checked `state` and the
 * session; this page only shows the result: a successful return goes on to the team's repository
 * screen, a failed one explains what to do.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const teamRaw = first(query.team) ?? first(query.teamId);
  const teamId = teamRaw && UUID.test(teamRaw) ? teamRaw : null;
  const installation = parseInstallationId(
    first(query.installation) ?? first(query.installation_id),
  );
  const error = parseSetupError(first(query.error));

  if (teamId && installation !== null && !error) {
    redirect(`/teams/${teamId}/github?installation=${installation}`);
  }
  const failureCode = error ?? (teamId ? 'unknown' : null);
  return (
    <div className="page-narrow stack">
      <h1>{t('github.setup.title')}</h1>
      <Alert tone="error">
        <p>
          <strong>{t('github.setup.failedTitle')}</strong>
        </p>
        <p>{failureCode ? setupErrorText(failureCode) : t('github.setup.unknownTeam')}</p>
      </Alert>
      <p>
        {teamId ? (
          <Link href={`/teams/${teamId}/github`}>{t('github.setup.toTeam')}</Link>
        ) : (
          <Link href="/teams">{t('github.setup.toTeams')}</Link>
        )}
      </p>
    </div>
  );
}
