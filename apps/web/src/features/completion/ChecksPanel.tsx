'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import {
  latestCheckKey,
  requestCheck,
  type CompletionCheck,
  type CompletionCheckResult,
} from './api';
import {
  checkHint,
  checkTitle,
  formatRemaining,
  httpStatusOf,
  isCheckFresh,
  isReleaseResult,
  reasonText,
  retryAtOf,
} from './model';
import { isCheckInProgress, useLatestCheck } from './queries';
import { useNow } from './useNow';

function CheckEntry({ result }: { result: CompletionCheckResult }) {
  const hint = checkHint(result.key);
  const status = httpStatusOf(result);
  const reason = result.ok ? null : reasonText(result);
  return (
    <li className="card nested stack">
      <h3>{checkTitle(result.key)}</h3>
      <p>
        <strong>{result.ok ? t('completion.checks.passed') : t('completion.checks.failed')}</strong>
        {result.ok
          ? null
          : ` · ${result.blocking ? t('completion.checks.blocking') : t('completion.checks.warning')}`}
      </p>
      {hint && !result.ok ? <p className="muted">{hint}</p> : null}
      {reason ? <p className="muted">{t('completion.checks.reasonLabel', { reason })}</p> : null}
      {status !== null && !result.ok ? (
        <p className="muted">{t('completion.checks.httpStatus', { status })}</p>
      ) : null}
    </li>
  );
}

/** Until when the second release check is not possible: a countdown, or the rule when the date is unknown. */
function SecondCheckNote({ result, now }: { result: CompletionCheckResult; now: Date }) {
  const retryAt = retryAtOf(result);
  if (!retryAt) return <p role="timer">{t('completion.checks.secondCheck.rule')}</p>;
  const left = retryAt.getTime() - now.getTime();
  return (
    <p role="timer">
      {left > 0
        ? t('completion.checks.secondCheck.wait', { time: formatRemaining(left) })
        : t('completion.checks.secondCheck.ready')}
    </p>
  );
}

function CheckResults({ check, now }: { check: CompletionCheck; now: Date }) {
  const release = check.results.find((result) => isReleaseResult(result) && !result.ok);
  return (
    <div className="stack">
      <ul className="stack" aria-label={t('completion.checks.list')}>
        {check.results.map((result) => (
          <CheckEntry key={result.key} result={result} />
        ))}
      </ul>
      {release ? <SecondCheckNote result={release} now={now} /> : null}
      {check.validUntil ? (
        <p className="muted">
          {isCheckFresh(check, now)
            ? t('completion.checks.validUntil', {
                time: new Date(check.validUntil).toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })
            : t('completion.checks.expired')}
        </p>
      ) : null}
    </div>
  );
}

function CheckState({ check, now }: { check: CompletionCheck | null; now: Date }) {
  if (!check) return <p className="muted">{t('completion.checks.none')}</p>;
  if (check.status === 'queued') return <p role="status">{t('completion.checks.queued')}</p>;
  if (check.status === 'running') return <p role="status">{t('completion.checks.inProgress')}</p>;
  if (check.status === 'failed')
    return <Alert tone="error">{t('completion.checks.failedRun')}</Alert>;
  return <CheckResults check={check} now={now} />;
}

function useRunChecks(teamId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (_: void, key) => requestCheck(teamId, key),
    onSuccess: (check) => queryClient.setQueryData(latestCheckKey(teamId), check),
  });
}

/** Starts the readiness checks (lead) and shows the state of the latest one; polls until it is done. */
export function ChecksPanel({ teamId, isLead }: { teamId: string; isLead: boolean }) {
  const latest = useLatestCheck(teamId);
  const run = useRunChecks(teamId);
  const now = useNow();
  const busy = run.isPending || isCheckInProgress(latest.data);
  return (
    <div className="stack">
      <p className="muted">{t('completion.checks.hint')}</p>
      {isLead ? (
        <div>
          <button type="button" className="button" disabled={busy} onClick={() => run.mutate()}>
            {busy ? t('completion.checks.running') : t('completion.checks.run')}
          </button>
        </div>
      ) : null}
      {run.isError ? <Alert tone="error">{describeError(run.error)}</Alert> : null}
      {latest.isError ? <Alert tone="error">{t('completion.checks.loadFailed')}</Alert> : null}
      {latest.isPending ? <p role="status">{t('completion.loading')}</p> : null}
      {latest.isSuccess ? <CheckState check={latest.data} now={now} /> : null}
    </div>
  );
}
