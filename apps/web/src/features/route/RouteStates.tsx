'use client';

import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';

/** Loading / failure of the workspace queries, shared by the route and the stage pages. */
export function isHiddenError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

export function LoadFailure({
  hidden,
  loadFailedKey,
  notFoundKey,
  onRetry,
}: {
  /** The resource is missing or not visible to the user (403/404): retrying would not help. */
  hidden: boolean;
  loadFailedKey: 'route.loadFailed' | 'route.stage.loadFailed';
  notFoundKey: 'route.notFound' | 'route.stage.notFound';
  onRetry: () => void;
}) {
  return (
    <Alert tone="error">
      <p>{t(hidden ? notFoundKey : loadFailedKey)}</p>
      {hidden ? null : (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {t('route.retry')}
        </button>
      )}
    </Alert>
  );
}
