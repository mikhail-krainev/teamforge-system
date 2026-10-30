'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import type { CatalogEntry } from '@/features/profile/api';
import { useRoles } from '@/features/profile/useProfileQueries';
import { RecommendedTeams } from '@/features/recommendations/RecommendedTeams';
import { isVersionConflict } from '@/features/teams/errors';
import { t } from '@/i18n';
import { APPLICATION_KEY, type SearchApplication } from './api';
import { ApplicationConflict, applicationFromConflict } from './ApplicationConflict';
import { ApplicationForm } from './ApplicationForm';
import { MatchingErrorAlert } from './MatchingErrorAlert';
import './matching.css';
import { orderedRoleCodes, toApplicationRoles } from './model';
import { useMyApplication } from './queries';
import { useApplicationActions } from './useApplicationActions';

function CancelBlock({ pending, onConfirm }: { pending: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <div>
        <button type="button" className="button button-danger" onClick={() => setAsking(true)}>
          {t('matching.search.cancelOpen')}
        </button>
      </div>
    );
  }
  return (
    <div className="card stack" role="group" aria-labelledby="application-cancel-title">
      <h3 id="application-cancel-title">{t('matching.search.cancelTitle')}</h3>
      <p>{t('matching.search.cancelText')}</p>
      <div className="row">
        <button
          type="button"
          className="button button-danger"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? t('matching.search.cancelling') : t('matching.search.cancelConfirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() => setAsking(false)}
        >
          {t('matching.search.cancelKeep')}
        </button>
      </div>
    </div>
  );
}

function StatusCard({
  application,
  roles,
}: {
  application: SearchApplication;
  roles: readonly CatalogEntry[];
}) {
  const codes = orderedRoleCodes(application);
  return (
    <section className="block block-blue queue-strip" aria-labelledby="application-status-heading">
      <div className="stack">
        <h2 id="application-status-heading">{t('matching.search.statusTitle')}</h2>
        <p role="status">
          <strong>{t('matching.search.statusActive')}</strong>
          {' · '}
          {t('matching.search.since', {
            date: new Date(application.enqueuedAt).toLocaleString('ru-RU'),
          })}
        </p>
        <h3>{t('matching.search.rolesTitle')}</h3>
        <ol aria-label={t('matching.search.rolesTitle')}>
          {codes.map((code, index) => (
            <li key={code}>
              {t('matching.search.roleLine', {
                n: index + 1,
                role: roles.find((r) => r.code === code)?.name ?? code,
              })}
            </li>
          ))}
        </ol>
      </div>
      <Yeti pose="think" size={120} />
    </section>
  );
}

interface ActiveProps {
  application: SearchApplication;
  roles: readonly CatalogEntry[];
  onCancelled: () => void;
}

function ActiveApplication({ application, roles, onCancelled }: ActiveProps) {
  const { update, cancel } = useApplicationActions(onCancelled);
  const queryClient = useQueryClient();
  const [formKey, setFormKey] = useState(0);
  const conflict = isVersionConflict(update.error);
  const mine = update.variables?.roles ?? [];
  return (
    <>
      <StatusCard application={application} roles={roles} />
      {conflict ? (
        <ApplicationConflict
          current={applicationFromConflict(update.error)}
          roles={roles}
          busy={update.isPending}
          onOverwrite={(latest) => update.mutate({ roles: mine, version: latest.version })}
          onAdopt={(latest) => {
            // The stored application is the new truth: the status card and the form follow it.
            queryClient.setQueryData(APPLICATION_KEY, latest);
            update.reset();
            setFormKey((key) => key + 1);
          }}
        />
      ) : null}
      {update.isError && !conflict ? <MatchingErrorAlert error={update.error} /> : null}
      {update.isSuccess ? <Alert tone="success">{t('matching.search.saved')}</Alert> : null}
      <ApplicationForm
        key={`${formKey}:${application.version}`}
        mode="update"
        initial={orderedRoleCodes(application)}
        roles={roles}
        pending={update.isPending}
        onEdit={() => update.isSuccess && update.reset()}
        onSubmit={(codes) =>
          update.mutate({ roles: toApplicationRoles(codes), version: application.version })
        }
      />
      {cancel.isError ? <MatchingErrorAlert error={cancel.error} /> : null}
      <CancelBlock pending={cancel.isPending} onConfirm={() => cancel.mutate()} />
    </>
  );
}

function NewApplication({
  roles,
  cancelled,
}: {
  roles: readonly CatalogEntry[];
  cancelled: boolean;
}) {
  const { create } = useApplicationActions();
  return (
    <>
      {cancelled ? <Alert tone="info">{t('matching.search.cancelled')}</Alert> : null}
      {create.isError ? <MatchingErrorAlert error={create.error} /> : null}
      <ApplicationForm
        mode="create"
        initial={[]}
        roles={roles}
        pending={create.isPending}
        onSubmit={(codes) => create.mutate(toApplicationRoles(codes))}
      />
    </>
  );
}

/** `/search`: the queue application (create / change / cancel) and the recommended teams. */
export function SearchPage() {
  const application = useMyApplication();
  const roles = useRoles();
  const [cancelled, setCancelled] = useState(false);
  if (application.isError || roles.isError) {
    return (
      <Alert tone="error">
        <p>{t('matching.search.loadFailed')}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            void application.refetch();
            void roles.refetch();
          }}
        >
          {t('matching.retry')}
        </button>
      </Alert>
    );
  }
  if (application.isPending || !roles.data) {
    return (
      <div className="row">
        <Yeti pose="think" size={96} />
        <p role="status">{t('matching.search.loading')}</p>
      </div>
    );
  }
  const stored = application.data;
  return (
    <div className="stack">
      {stored ? (
        <ActiveApplication
          application={stored}
          roles={roles.data}
          onCancelled={() => setCancelled(true)}
        />
      ) : (
        <NewApplication roles={roles.data} cancelled={cancelled} />
      )}
      <RecommendedTeams roles={roles.data} />
    </div>
  );
}
