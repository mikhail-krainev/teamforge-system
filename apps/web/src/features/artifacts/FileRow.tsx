'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { checklistRootKey } from '@/features/route/api';
import { deleteArtifactFile, type ArtifactFile } from './api';
import { artifactErrorText } from './errors';
import { useDownloadUrl } from './queries';
import { formatFileSize } from './validate';

interface RowProps {
  teamId: string;
  itemId: string;
  file: ArtifactFile;
  canRemove: boolean;
}

function DownloadLink({ teamId, itemId, file }: Omit<RowProps, 'canRemove'>) {
  const url = useDownloadUrl(teamId, itemId, file.id);
  if (url.isError) {
    return (
      <button type="button" className="button button-secondary" onClick={() => void url.refetch()}>
        {t('artifacts.downloadRetry', { name: file.originalName })}
      </button>
    );
  }
  if (!url.data) {
    return (
      <span className="muted">{t('artifacts.downloadLoading', { name: file.originalName })}</span>
    );
  }
  return (
    <a
      href={url.data.url}
      download={file.originalName}
      rel="noopener noreferrer"
      aria-label={t('artifacts.download', { name: file.originalName })}
    >
      {file.originalName}
    </a>
  );
}

function useRemove(teamId: string, itemId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (fileId: string, key) => deleteArtifactFile({ teamId, itemId }, fileId, key),
    // The item version moved with the file list: the checklist is re-read before the row goes.
    onSettled: () => queryClient.invalidateQueries({ queryKey: checklistRootKey(teamId) }),
  });
}

function RemoveControl({ teamId, itemId, file }: Omit<RowProps, 'canRemove'>) {
  const [asking, setAsking] = useState(false);
  const remove = useRemove(teamId, itemId);
  const name = file.originalName;
  if (!asking) {
    return (
      <button
        type="button"
        className="button button-secondary"
        aria-label={t('artifacts.remove', { name })}
        onClick={() => {
          remove.reset();
          setAsking(true);
        }}
      >
        {t('artifacts.removeConfirmOpen')}
      </button>
    );
  }
  return (
    <div className="stack" role="group" aria-label={t('artifacts.removeAsk', { name })}>
      <p>{t('artifacts.removeAsk', { name })}</p>
      {remove.isError ? <Alert tone="error">{artifactErrorText(remove.error)}</Alert> : null}
      <div className="row">
        <button
          type="button"
          className="button button-danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate(file.id)}
        >
          {remove.isPending ? t('artifacts.removing') : t('artifacts.removeConfirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={remove.isPending}
          onClick={() => setAsking(false)}
        >
          {t('artifacts.removeCancel')}
        </button>
      </div>
    </div>
  );
}

/** One uploaded file: the download link (signed, fetched on render) and, for author or lead, removal. */
export function FileRow({ teamId, itemId, file, canRemove }: RowProps) {
  return (
    <li className="stack">
      <p>
        <DownloadLink teamId={teamId} itemId={itemId} file={file} />{' '}
        <span className="muted">{formatFileSize(file.sizeBytes)}</span>
      </p>
      {canRemove ? <RemoveControl teamId={teamId} itemId={itemId} file={file} /> : null}
    </li>
  );
}
