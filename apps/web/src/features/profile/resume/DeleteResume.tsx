'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { t } from '@/i18n';
import { removeResume } from './api';

export function DeleteResume({ uploadId, onDeleted }: { uploadId: string; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const remove = useIdempotentMutation({
    mutationFn: (_: void, key) => removeResume(uploadId, key),
    onSuccess: () => {
      setAsking(false);
      onDeleted();
    },
  });

  if (!asking) {
    return (
      <div>
        <button type="button" className="button button-secondary" onClick={() => setAsking(true)}>
          {t('profile.resume.delete')}
        </button>
      </div>
    );
  }
  return (
    <div className="stack">
      {remove.isError ? <Alert tone="error">{describeError(remove.error)}</Alert> : null}
      <div className="row">
        <button
          type="button"
          className="button button-danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? t('profile.resume.deleting') : t('profile.resume.deleteConfirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={remove.isPending}
          onClick={() => setAsking(false)}
        >
          {t('profile.resume.deleteCancel')}
        </button>
      </div>
    </div>
  );
}
