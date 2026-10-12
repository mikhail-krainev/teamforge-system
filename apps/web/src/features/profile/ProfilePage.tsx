'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { PROFILE_KEY } from './api';
import { emptyDraft, toDraft, type Profile } from './model';
import { ProfileForm } from './ProfileForm';
import { ResumeSection } from './resume/ResumeSection';
import { browserTimezone } from './TimezoneSelect';
import { useMyProfile, useRoles, useStackTags } from './useProfileQueries';

export function ProfilePage() {
  const queryClient = useQueryClient();
  const profile = useMyProfile();
  const roles = useRoles();
  const tags = useStackTags();
  // Bumping the key remounts the form with fresh initial data (after adopting server data).
  const [formKey, setFormKey] = useState(0);

  if (profile.isError || roles.isError || tags.isError) {
    return (
      <LoadFailed
        onRetry={() => {
          void profile.refetch();
          void roles.refetch();
          void tags.refetch();
        }}
      />
    );
  }
  if (profile.isPending || !roles.data || !tags.data) {
    return <p role="status">{t('profile.page.loading')}</p>;
  }

  const stored = profile.data;
  const adopt = (current: Profile) => {
    queryClient.setQueryData(PROFILE_KEY, current);
    setFormKey((key) => key + 1);
  };
  return (
    <div className="stack">
      {stored === null ? <Alert tone="info">{t('profile.page.firstTime')}</Alert> : null}
      <ProfileForm
        key={formKey}
        initial={stored ? toDraft(stored) : emptyDraft(browserTimezone())}
        version={stored?.version ?? null}
        roles={roles.data}
        tags={tags.data}
        onAdoptCurrent={adopt}
      />
      <ResumeSection profileVersion={stored?.version ?? null} onProfileChanged={adopt} />
      {stored ? (
        <p>
          <Link href={`/users/${stored.userId}`}>{t('profile.page.viewPublic')}</Link>
        </p>
      ) : null}
    </div>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert tone="error">
      <p>{t('profile.page.loadFailed')}</p>
      <button type="button" className="button button-secondary" onClick={onRetry}>
        {t('profile.page.retry')}
      </button>
    </Alert>
  );
}
