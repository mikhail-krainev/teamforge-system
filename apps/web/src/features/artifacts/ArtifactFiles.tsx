'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ChangeEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { checklistRootKey, type ChecklistItem } from '@/features/route/api';
import { uploadArtifactFile } from './api';
import { artifactErrorText } from './errors';
import { FileRow } from './FileRow';
import { checkArtifactFile, FILE_ACCEPT } from './validate';

interface Props {
  teamId: string;
  item: ChecklistItem;
  meId: string;
  isLead: boolean;
  /** The stage is open and the team can work; the item itself must also be open to change files. */
  editable: boolean;
}

interface UploadVariables {
  file: File;
  /** Tells two files of the same size apart for the idempotency fingerprint. */
  id: string;
}

function useUpload(teamId: string, itemId: string) {
  const queryClient = useQueryClient();
  const [percent, setPercent] = useState(0);
  const mutation = useIdempotentMutation({
    mutationFn: (variables: UploadVariables, key) => {
      setPercent(0);
      return uploadArtifactFile({ teamId, itemId }, variables.file, key, setPercent);
    },
    // Awaited: the file is listed from the re-read item, so the progress stays until it is there.
    onSettled: () => queryClient.invalidateQueries({ queryKey: checklistRootKey(teamId) }),
  });
  return { mutation, percent };
}

function UploadProgress({ name, percent }: { name: string; percent: number }) {
  return (
    <div className="stack">
      <p role="status">{t('artifacts.uploading', { name, percent })}</p>
      <progress max={100} value={percent} aria-label={t('artifacts.progress')} />
    </div>
  );
}

function UploadField({
  id,
  disabled,
  onPick,
}: {
  id: string;
  disabled: boolean;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <Field id={id} label={t('artifacts.upload')} hint={t('artifacts.uploadHint')}>
      {(control) => (
        <input
          {...control}
          type="file"
          accept={FILE_ACCEPT}
          disabled={disabled}
          onChange={onPick}
        />
      )}
    </Field>
  );
}

/** Files of an artifact item: upload with progress, signed download links, removal (FR-WORK-05). */
export function ArtifactFiles({ teamId, item, meId, isLead, editable }: Props) {
  const id = useId();
  const [localError, setLocalError] = useState<string | null>(null);
  const { mutation, percent } = useUpload(teamId, item.id);
  const canChange = editable && item.status === 'open';
  const error = localError ?? (mutation.isError ? artifactErrorText(mutation.error) : null);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const verdict = checkArtifactFile(file);
    if (verdict !== 'ok') return setLocalError(t(`artifacts.client.${verdict}`));
    setLocalError(null);
    mutation.reset();
    mutation.mutate({ file, id: `${file.name}:${file.size}:${file.lastModified}` });
  }

  return (
    <section className="stack">
      {canChange ? (
        <UploadField id={`${id}-file`} disabled={mutation.isPending} onPick={pick} />
      ) : null}
      {editable && item.status === 'done' && item.submission !== 'link' ? (
        <p className="muted">{t('artifacts.closedItemNotice')}</p>
      ) : null}
      {mutation.isPending ? (
        <UploadProgress name={mutation.variables.file.name} percent={percent} />
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <FileList
        teamId={teamId}
        item={item}
        canRemoveOf={(file) => canChange && (isLead || file.uploadedBy === meId)}
      />
    </section>
  );
}

function FileList({
  teamId,
  item,
  canRemoveOf,
}: {
  teamId: string;
  item: ChecklistItem;
  canRemoveOf: (file: ChecklistItem['files'][number]) => boolean;
}) {
  if (item.files.length === 0) return null;
  return (
    <ul className="stack" aria-label={t('artifacts.files')}>
      {item.files.map((file) => (
        <FileRow
          key={file.id}
          teamId={teamId}
          itemId={item.id}
          file={file}
          canRemove={canRemoveOf(file)}
        />
      ))}
    </ul>
  );
}
