'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { workspaceKey, type ChecklistItem, type ProjectStage } from '@/features/route/api';
import { teamEventsKey, teamKey } from '@/features/teams/api';
import { transitionStage } from './api';
import {
  isStageNotOpen,
  localUnmet,
  transitionErrorText,
  unmetFromError,
  unmetText,
  type UnmetEntry,
} from './unmet';

interface Props {
  teamId: string;
  stage: ProjectStage;
  nextOrdinal: number;
  items: readonly ChecklistItem[];
  reviewKeys: ReadonlySet<string>;
}

type Outcome = { kind: 'moved'; openedOrdinal: number | null } | { kind: 'stale' } | null;

function useTransition(teamId: string, fromOrdinal: number) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [serverUnmet, setServerUnmet] = useState<UnmetEntry[] | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamEventsKey(teamId) }),
    ]);
  const mutation = useIdempotentMutation({
    mutationFn: (_: void, key) => transitionStage(teamId, fromOrdinal, key),
    onSuccess: async (result) => {
      setOutcome({ kind: 'moved', openedOrdinal: result.openedOrdinal });
      await refresh();
    },
    onError: async (error) => {
      const unmet = unmetFromError(error);
      if (unmet) return setServerUnmet(unmet);
      if (isStageNotOpen(error)) setOutcome({ kind: 'stale' });
      await refresh();
    },
  });
  return { mutation, outcome, serverUnmet, clearUnmet: () => setServerUnmet(null) };
}

function UnmetList({
  entries,
  fromServer,
}: {
  entries: readonly UnmetEntry[];
  fromServer: boolean;
}) {
  return (
    <div className="stack">
      <p>
        <strong>{t('transition.unmetTitle')}</strong>
      </p>
      <ul className="stack" aria-label={t('transition.unmetList')}>
        {entries.map((entry) => (
          <li key={entry.code}>{unmetText(entry)}</li>
        ))}
      </ul>
      <p className="muted">
        {t(fromServer ? 'transition.unmetServer' : 'transition.unmetHintLocal')}
      </p>
    </div>
  );
}

function MovedNotice({ teamId, openedOrdinal }: { teamId: string; openedOrdinal: number | null }) {
  if (openedOrdinal === null) return <Alert tone="success">{t('transition.movedLast')}</Alert>;
  return (
    <Alert tone="success">
      <p>{t('transition.moved', { ordinal: openedOrdinal })}</p>
      <p>
        <Link href={`/teams/${teamId}/stages/${openedOrdinal}`}>
          {t('transition.goToStage', { ordinal: openedOrdinal })}
        </Link>
      </p>
    </Alert>
  );
}

interface ConfirmProps {
  nextOrdinal: number;
  entries: readonly UnmetEntry[];
  fromServer: boolean;
  pending: boolean;
  headingId: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmPanel(props: ConfirmProps) {
  const { entries, pending } = props;
  return (
    <div className="card stack" role="group" aria-labelledby={props.headingId}>
      <h3 id={props.headingId}>{t('transition.confirmTitle', { ordinal: props.nextOrdinal })}</h3>
      {entries.length > 0 ? (
        <UnmetList entries={entries} fromServer={props.fromServer} />
      ) : (
        <p className="muted">{t('transition.allMet')}</p>
      )}
      <p>{t('transition.confirmText')}</p>
      <div className="row">
        <button type="button" className="button" disabled={pending} onClick={props.onConfirm}>
          {pending ? t('transition.confirming') : t('transition.confirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={props.onCancel}
        >
          {t('transition.cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * Lead only (FR-WORK-10). The first click opens the confirmation with a hint about unmet
 * conditions; the server decides on confirmation and answers with `unmet[]` or 409 STAGE_NOT_OPEN
 * when another tab or participant already moved the project on.
 */
export function TransitionControl({ teamId, stage, nextOrdinal, items, reviewKeys }: Props) {
  const [confirming, setConfirming] = useState(false);
  const { mutation, outcome, serverUnmet, clearUnmet } = useTransition(teamId, stage.ordinal);
  const hint = localUnmet({ stage, items, reviewKeys, now: new Date() });

  if (outcome?.kind === 'moved') {
    return <MovedNotice teamId={teamId} openedOrdinal={outcome.openedOrdinal} />;
  }
  if (outcome?.kind === 'stale') {
    return <Alert tone="error">{t('transition.errors.STAGE_NOT_OPEN')}</Alert>;
  }
  const failure = mutation.isError && !serverUnmet ? transitionErrorText(mutation.error) : null;
  return (
    <div className="stack">
      {failure ? <Alert tone="error">{failure}</Alert> : null}
      {confirming ? (
        <ConfirmPanel
          nextOrdinal={nextOrdinal}
          entries={serverUnmet ?? hint}
          fromServer={serverUnmet !== null}
          pending={mutation.isPending}
          headingId={`transition-${stage.ordinal}`}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            clearUnmet();
            mutation.reset();
            setConfirming(false);
          }}
        />
      ) : (
        <div>
          <button type="button" className="button" onClick={() => setConfirming(true)}>
            {t('transition.open')}
          </button>
        </div>
      )}
    </div>
  );
}
