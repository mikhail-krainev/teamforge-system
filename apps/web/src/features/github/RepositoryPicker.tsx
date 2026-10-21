'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { linkRepository, repositoryKey, type AvailableRepository } from './api';
import { githubErrorText, isInstallationLost } from './errors';
import { useAvailableRepositories } from './queries';

function RepositoryOption({
  repository,
  checked,
  onSelect,
}: {
  repository: AvailableRepository;
  checked: boolean;
  onSelect: () => void;
}) {
  const id = useId();
  return (
    <div className="checkbox">
      <input
        id={id}
        type="radio"
        name="repository"
        value={repository.repositoryId}
        checked={checked}
        onChange={onSelect}
      />
      <label htmlFor={id}>
        {repository.fullName}
        {repository.private ? ` (${t('github.picker.notPublic')})` : ''}
        {repository.fork ? ` (${t('github.picker.fork')})` : ''}
      </label>
    </div>
  );
}

function useLink(teamId: string, installationId: number) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (repositoryId: number, key) =>
      linkRepository(teamId, { installationId, repositoryId }, key),
    onSuccess: (link) => queryClient.setQueryData(repositoryKey(teamId), link),
  });
}

function PickerFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const lost = isInstallationLost(error);
  return (
    <Alert tone="error">
      <p>{lost ? githubErrorText(error) : t('github.picker.loadFailed')}</p>
      {lost ? null : (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {t('github.retry')}
        </button>
      )}
    </Alert>
  );
}

function LoadMore({ list }: { list: ReturnType<typeof useAvailableRepositories> }) {
  if (!list.hasNextPage) return null;
  return (
    <div>
      <button
        type="button"
        className="button button-secondary"
        disabled={list.isFetchingNextPage}
        onClick={() => void list.fetchNextPage()}
      >
        {list.isFetchingNextPage ? t('github.picker.loadingMore') : t('github.picker.loadMore')}
      </button>
    </div>
  );
}

function LinkButton({
  hintId,
  selected,
  pending,
  onLink,
}: {
  hintId: string;
  selected: boolean;
  pending: boolean;
  onLink: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="button"
        disabled={!selected || pending}
        aria-describedby={selected ? undefined : hintId}
        onClick={onLink}
      >
        {pending ? t('github.picker.linking') : t('github.picker.link')}
      </button>
      {selected ? null : (
        <span id={hintId} className="muted">
          {' '}
          {t('github.picker.chooseFirst')}
        </span>
      )}
    </div>
  );
}

/** Choice of the repository among those of the installation, and the binding (lead only). */
export function RepositoryPicker({
  teamId,
  installationId,
}: {
  teamId: string;
  installationId: number;
}) {
  const hintId = useId();
  const list = useAvailableRepositories(teamId, installationId);
  const link = useLink(teamId, installationId);
  const [selected, setSelected] = useState<number | null>(null);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  if (list.isPending) return <p role="status">{t('github.picker.loading')}</p>;
  if (list.isError) return <PickerFailure error={list.error} onRetry={() => void list.refetch()} />;
  if (items.length === 0) return <p className="muted">{t('github.picker.empty')}</p>;
  return (
    <div className="stack">
      <div role="radiogroup" aria-label={t('github.picker.label')} className="stack">
        {items.map((repository) => (
          <RepositoryOption
            key={repository.repositoryId}
            repository={repository}
            checked={repository.repositoryId === selected}
            onSelect={() => setSelected(repository.repositoryId)}
          />
        ))}
      </div>
      <LoadMore list={list} />
      {items.find((item) => item.repositoryId === selected)?.private ? (
        <p className="muted">{t('github.picker.notPublicHint')}</p>
      ) : null}
      {link.isError ? <Alert tone="error">{githubErrorText(link.error)}</Alert> : null}
      <LinkButton
        hintId={hintId}
        selected={selected !== null}
        pending={link.isPending}
        onLink={() => selected !== null && link.mutate(selected)}
      />
    </div>
  );
}
