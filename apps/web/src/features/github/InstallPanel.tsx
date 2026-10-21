'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { createInstallationSession } from './api';
import { githubErrorText } from './errors';
import { safeInstallUrl } from './model';

/** Starts the installation: the server returns the GitHub URL with a one-time `state`; the browser goes there. */
export function InstallPanel({ teamId }: { teamId: string }) {
  const [badUrl, setBadUrl] = useState(false);
  const mutation = useIdempotentMutation({
    mutationFn: (_: void, key) => createInstallationSession(teamId, key),
    onSuccess: (session) => {
      const url = safeInstallUrl(session.installUrl);
      if (!url) return setBadUrl(true);
      window.location.assign(url);
    },
  });
  const busy = mutation.isPending || mutation.isSuccess;
  return (
    <div className="stack">
      <p className="muted">{t('github.install.hint')}</p>
      {mutation.isError ? <Alert tone="error">{githubErrorText(mutation.error)}</Alert> : null}
      {badUrl ? <Alert tone="error">{t('github.install.badUrl')}</Alert> : null}
      <div>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setBadUrl(false);
            mutation.mutate();
          }}
        >
          {busy ? t('github.install.pending') : t('github.install.button')}
        </button>
      </div>
    </div>
  );
}
