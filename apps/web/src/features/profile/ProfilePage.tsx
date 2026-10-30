'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { LoadingState } from '@/components/ui/LoadingState';
import { t } from '@/i18n';
import { PROFILE_KEY } from './api';
import { emptyDraft, toDraft, type Profile } from './model';
import { ProfileForm } from './ProfileForm';
import { ResumeSection } from './resume/ResumeSection';
import { browserTimezone } from './TimezoneSelect';
import { useMyProfile, useRoles, useStackTags } from './useProfileQueries';

/**
 * How new server data reaches the form. Remounting (a new `formKey`) throws away unsaved edits
 * (S2CR-09), so it happens only when the user chose the server's data (`adopt`) or the form has no
 * edits. A profile changed by the resume while the form has edits only marks the form `stale`.
 */
function useProfileAdoption() {
  const queryClient = useQueryClient();
  const [formKey, setFormKey] = useState(0);
  const [stale, setStale] = useState(false);
  const dirty = useRef(false);

  const adopt = (current: Profile) => {
    queryClient.setQueryData(PROFILE_KEY, current);
    dirty.current = false;
    setStale(false);
    setFormKey((key) => key + 1);
  };
  const profileChanged = (current: Profile) => {
    queryClient.setQueryData(PROFILE_KEY, current);
    if (dirty.current) setStale(true);
    else setFormKey((key) => key + 1);
  };
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
    if (!value) setStale(false);
  }, []);
  return { formKey, stale, adopt, profileChanged, onDirtyChange };
}

export function ProfilePage() {
  const profile = useMyProfile();
  const roles = useRoles();
  const tags = useStackTags();
  const { formKey, stale, adopt, profileChanged, onDirtyChange } = useProfileAdoption();

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
    return <LoadingState text={t('profile.page.loading')} />;
  }

  const stored = profile.data;
  return (
    <div className="stack">
      {stored === null ? <Alert tone="info">{t('profile.page.firstTime')}</Alert> : null}
      {stale && stored ? (
        <Alert tone="warn">
          <p>{t('profile.page.stale')}</p>
          <button type="button" className="button button-secondary" onClick={() => adopt(stored)}>
            {t('profile.page.staleReload')}
          </button>
        </Alert>
      ) : null}
      <ProfileForm
        key={formKey}
        initial={stored ? toDraft(stored) : emptyDraft(browserTimezone())}
        version={stored?.version ?? null}
        roles={roles.data}
        tags={tags.data}
        onAdoptCurrent={adopt}
        onDirtyChange={onDirtyChange}
      />
      <ResumeSection profileVersion={stored?.version ?? null} onProfileChanged={profileChanged} />
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
