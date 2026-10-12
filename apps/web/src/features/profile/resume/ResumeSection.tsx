'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import { describeError } from '@/lib/api/error-message';
import { t } from '@/i18n';
import type { Profile } from '../model';
import { fetchMyResume, isInProgress, POLL_MS, RESUME_KEY, type ResumeUpload } from './api';
import { DeleteResume } from './DeleteResume';
import { SuggestionsForm } from './SuggestionsForm';
import { UploadForm } from './UploadForm';

interface Props {
  profileVersion: number | null;
  onProfileChanged: (profile: Profile) => void;
}

function statusText(upload: ResumeUpload | null | undefined): string {
  if (!upload) return '';
  if (upload.status === 'failed') {
    return upload.failureReason
      ? t(`profile.resume.failure.${upload.failureReason}`)
      : t('profile.resume.status.failed');
  }
  return t(`profile.resume.status.${upload.status}`);
}

export function ResumeSection({ profileVersion, onProfileChanged }: Props) {
  const queryClient = useQueryClient();
  const resume = useQuery({
    queryKey: RESUME_KEY,
    queryFn: () => fetchMyResume(),
    // Poll while the worker is busy; stops by itself once the status is final.
    refetchInterval: (query) => (isInProgress(query.state.data) ? POLL_MS : false),
  });
  const upload = resume.data;
  const canUpload = !upload || upload.status === 'done' || upload.status === 'failed';
  const reset = () => queryClient.setQueryData(RESUME_KEY, null);

  return (
    <section className="card stack" aria-labelledby="resume-heading">
      <h2 id="resume-heading">{t('profile.resume.title')}</h2>
      <p className="muted">{t('profile.resume.lead')}</p>
      {resume.isError && !upload ? <Alert tone="error">{describeError(resume.error)}</Alert> : null}
      {resume.isError && upload ? <p className="muted">{t('profile.resume.pollFailed')}</p> : null}
      {/* Announces every status change of the parser to assistive technology. */}
      <p role="status" aria-live="polite" aria-label={t('profile.resume.statusLabel')}>
        {statusText(upload)}
      </p>
      {upload && upload.status === 'done' ? (
        <SuggestionsForm
          upload={upload}
          profileVersion={profileVersion}
          onConfirmed={(profile) => {
            reset();
            onProfileChanged(profile);
          }}
          onConflict={onProfileChanged}
        />
      ) : null}
      {canUpload ? (
        <UploadForm onUploaded={(next) => queryClient.setQueryData(RESUME_KEY, next)} />
      ) : null}
      {upload ? <DeleteResume uploadId={upload.id} onDeleted={reset} /> : null}
    </section>
  );
}
