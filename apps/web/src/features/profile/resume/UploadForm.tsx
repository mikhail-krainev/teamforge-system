'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { t } from '@/i18n';
import { checkResumeFile, uploadResume, type ResumeUpload } from './api';

const ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function UploadForm({ onUploaded }: { onUploaded: (upload: ResumeUpload) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | undefined>();
  const upload = useIdempotentMutation({
    // `id` keeps two different files of the same size apart for the idempotency fingerprint.
    mutationFn: (variables: { file: File; id: string }, key) => uploadResume(variables.file, key),
    onSuccess: onUploaded,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return setLocalError(t('profile.resume.noFile'));
    const verdict = checkResumeFile(file);
    if (verdict !== 'ok') return setLocalError(t(`profile.resume.${verdict}`));
    setLocalError(undefined);
    upload.mutate({ file, id: `${file.name}:${file.size}:${file.lastModified}` });
  }

  return (
    <form onSubmit={submit} noValidate className="stack">
      <Field
        id="resume-file"
        label={t('profile.resume.file')}
        hint={t('profile.resume.fileHint')}
        error={localError}
      >
        {(control) => (
          <input
            {...control}
            type="file"
            accept={ACCEPT}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setLocalError(undefined);
            }}
          />
        )}
      </Field>
      {upload.isError ? <Alert tone="error">{describeError(upload.error)}</Alert> : null}
      <button type="submit" className="button" disabled={upload.isPending}>
        {upload.isPending ? t('profile.resume.uploading') : t('profile.resume.upload')}
      </button>
    </form>
  );
}
