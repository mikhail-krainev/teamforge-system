'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t, type MessageKey } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { formatDate } from '@/features/route/model';
import { githubRootKey, unlinkRepository, type RepositoryLink } from './api';
import { githubErrorText } from './errors';
import { githubRepositoryUrl } from './model';

function Unlink({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useIdempotentMutation({
    mutationFn: (_: void, key) => unlinkRepository(teamId, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: githubRootKey(teamId) }),
  });
  if (!confirming) {
    return (
      <div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setConfirming(true)}
        >
          {t('github.unlink.button')}
        </button>
      </div>
    );
  }
  return (
    <div className="card stack" role="group" aria-labelledby="unlink-title">
      <h3 id="unlink-title">{t('github.unlink.title')}</h3>
      <p>{t('github.unlink.text')}</p>
      {mutation.isError ? <Alert tone="error">{githubErrorText(mutation.error)}</Alert> : null}
      <div className="row">
        <button
          type="button"
          className="button button-danger"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? t('github.unlink.confirming') : t('github.unlink.confirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={mutation.isPending}
          onClick={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          {t('github.unlink.cancel')}
        </button>
      </div>
    </div>
  );
}

/** The repository the team works in: its state, warnings of the link and (for the lead) the unlink. */
export function LinkedRepository({
  teamId,
  repository,
  isLead,
}: {
  teamId: string;
  repository: RepositoryLink;
  isLead: boolean;
}) {
  const url = githubRepositoryUrl(repository.fullName);
  return (
    <section className="stack" aria-labelledby="linked-title">
      <h2 id="linked-title" className="sr-only">
        {t('github.links.github')}
      </h2>
      <div role="status" className="alert alert-success stack">
        <p>
          <strong>{t('github.linked.status', { name: repository.fullName })}</strong>
        </p>
        <p>{t('github.linked.since', { date: formatDate(repository.linkedAt) })}</p>
      </div>
      {url ? (
        <p>
          <a href={url} target="_blank" rel="noopener noreferrer">
            {t('github.linked.open')}
          </a>
        </p>
      ) : null}
      {repository.warnings.map((warning) => (
        <Alert key={warning} tone="warn">
          {t(`github.linked.warnings.${warning}` satisfies MessageKey)}
        </Alert>
      ))}
      {repository.status === 'completed' ? (
        <p className="muted">{t('github.linked.completed')}</p>
      ) : isLead ? (
        <Unlink teamId={teamId} />
      ) : null}
    </section>
  );
}
