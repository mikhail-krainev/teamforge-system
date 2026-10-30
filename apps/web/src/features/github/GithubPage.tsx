'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { LoadingState } from '@/components/ui/LoadingState';
import { useMe } from '@/features/auth/session';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { isHiddenError } from '@/features/route/RouteStates';
import { useTeam } from '@/features/teams/queries';
import { t } from '@/i18n';
import { InstallPanel } from './InstallPanel';
import { LinkedRepository } from './LinkedRepository';
import { parseInstallationId, parseSetupError } from './model';
import { setupErrorText } from './errors';
import { useRepository } from './queries';
import { RepositoryPicker } from './RepositoryPicker';

interface Props {
  teamId: string;
  /** `?installation=` of the return from GitHub (already read from the URL by the page). */
  installation?: string | undefined;
  /** `?error=` of a failed return. */
  error?: string | undefined;
}

function ConnectSection({ teamId, installation, error }: Props) {
  const installationId = parseInstallationId(installation);
  const errorCode = parseSetupError(error);
  return (
    <div className="stack">
      {errorCode ? (
        <Alert tone="error">
          <p>
            <strong>{t('github.setup.failedTitle')}</strong>
          </p>
          <p>{setupErrorText(errorCode)}</p>
        </Alert>
      ) : null}
      {installationId !== null ? (
        <>
          <Alert tone="success">{t('github.install.doneNumber', { id: installationId })}</Alert>
          <RepositoryPicker teamId={teamId} installationId={installationId} />
        </>
      ) : (
        <InstallPanel teamId={teamId} />
      )}
    </div>
  );
}

function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const hidden = isHiddenError(error);
  return (
    <Alert tone="error">
      <p>{t(hidden ? 'github.notFound' : 'github.loadFailed')}</p>
      {hidden ? null : (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {t('github.retry')}
        </button>
      )}
    </Alert>
  );
}

export function GithubPage(props: Props) {
  const { teamId } = props;
  useTeamChannel(teamId);
  const me = useMe();
  const team = useTeam(teamId);
  const repository = useRepository(teamId);

  const failed = team.isError ? team : repository.isError ? repository : null;
  if (failed) return <LoadFailure error={failed.error} onRetry={() => void failed.refetch()} />;
  if (!team.data || repository.data === undefined) {
    return <LoadingState text={t('github.loading')} />;
  }

  const isLead = Boolean(me.data && team.data.leadUserId === me.data.id);
  const link = repository.data;
  const bound = link !== null && link.status !== 'unlinked';
  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('github.title')}</h1>
        <div className="page-aside">
          <p className="muted">{t('github.projectsHint')}</p>
          <Link href={`/teams/${teamId}`} className="text-link">
            {t('github.back')}
          </Link>
        </div>
      </header>
      {link && bound ? (
        <LinkedRepository teamId={teamId} repository={link} isLead={isLead} />
      ) : null}
      {link?.status === 'unlinked' ? (
        <Alert tone="warn">
          <p>{t('github.linked.unlinked')}</p>
          <p>{t('github.linked.unlinkedName', { name: link.fullName })}</p>
        </Alert>
      ) : null}
      {!bound && !link ? <p className="muted">{t('github.noRepository')}</p> : null}
      {!bound && isLead ? <ConnectSection {...props} /> : null}
      {!bound && !isLead ? <p className="muted">{t('github.leadOnly')}</p> : null}
    </div>
  );
}
