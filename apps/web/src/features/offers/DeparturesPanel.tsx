'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import type { CatalogEntry } from '@/features/profile/api';
import { teamKey, type Seat } from '@/features/teams/api';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { decideDeparture, departuresKey, type Departure, type DepartureDecision } from './api';
import { ActionErrorAlert } from './ActionErrorAlert';
import { useDepartures } from './queries';

interface RowProps {
  teamId: string;
  departure: Departure;
  seats: readonly Seat[];
  roles: readonly CatalogEntry[];
  canDecide: boolean;
}

const roleOf = (roles: readonly CatalogEntry[], code: string) =>
  roles.find((r) => r.code === code)?.name ?? code;

interface DecisionProps {
  departure: Departure;
  seats: readonly Seat[];
  roles: readonly CatalogEntry[];
  pending: boolean;
  onDecide: (body: DepartureDecision) => void;
}

interface CheckboxProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}

function SeatCheckbox({ label, checked, disabled, onChange }: CheckboxProps) {
  return (
    <label className="row">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function DecisionControls({ departure, seats, roles, pending, onDecide }: DecisionProps) {
  const [closeIds, setCloseIds] = useState<string[]>([]);
  const toggle = (id: string) =>
    setCloseIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const seatLabel = (id: string) => {
    const seat = seats.find((s) => s.id === id);
    return t('offers.departures.closeSeats', { role: seat ? roleOf(roles, seat.roleCode) : id });
  };
  const label = (text: string) => (pending ? t('offers.departures.deciding') : text);
  return (
    <div className="stack" role="group" aria-label={t('offers.departures.decisionTitle')}>
      <fieldset className="stack">
        <legend>{t('offers.departures.closeFieldset')}</legend>
        {departure.seatIds.map((id) => (
          <SeatCheckbox
            key={id}
            label={seatLabel(id)}
            checked={closeIds.includes(id)}
            disabled={pending}
            onChange={() => toggle(id)}
          />
        ))}
      </fieldset>
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => onDecide({ decision: 'replace' })}
        >
          {label(t('offers.departures.replace'))}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() =>
            onDecide({
              decision: 'continue',
              ...(closeIds.length > 0 ? { closeSeatIds: closeIds } : {}),
            })
          }
        >
          {label(t('offers.departures.continue'))}
        </button>
      </div>
    </div>
  );
}

function DepartureRow({ teamId, departure, seats, roles, canDecide }: RowProps) {
  const queryClient = useQueryClient();
  const decide = useIdempotentMutation({
    mutationFn: (body: DepartureDecision, key) => decideDeparture(teamId, departure.id, body, key),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: departuresKey(teamId) }),
        queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      ]);
    },
  });
  const pending = departure.decision === 'pending';
  const roleNames = departure.roleCodes.map((c) => roleOf(roles, c)).join(', ');
  const decided =
    departure.decision === 'replace'
      ? 'offers.departures.decidedReplace'
      : 'offers.departures.decidedContinue';
  return (
    <li className="card stack">
      <p>
        <strong>{t(`offers.departures.reason.${departure.reason}`)}</strong>
      </p>
      <p className="muted">{t('offers.departures.roles', { roles: roleNames })}</p>
      {pending ? (
        <p className="muted">
          {t('offers.departures.due', { date: new Date(departure.dueAt).toLocaleString('ru-RU') })}
        </p>
      ) : (
        <p role="status">{t(decided)}</p>
      )}
      {decide.isError ? <ActionErrorAlert error={decide.error} /> : null}
      {pending && !canDecide ? <p className="muted">{t('offers.departures.leadOnly')}</p> : null}
      {pending && canDecide ? (
        <DecisionControls
          departure={departure}
          seats={seats}
          roles={roles}
          pending={decide.isPending}
          onDecide={(body) => decide.mutate(body)}
        />
      ) : null}
    </li>
  );
}

interface Props {
  teamId: string;
  seats: readonly Seat[];
  roles: readonly CatalogEntry[];
  canDecide: boolean;
}

/** Departures waiting for the lead's decision: replace from the queue or continue without. */
export function DeparturesPanel({ teamId, seats, roles, canDecide }: Props) {
  const departures = useDepartures(teamId);
  return (
    <section className="stack" aria-labelledby="departures-heading">
      <h2 id="departures-heading">{t('offers.departures.title')}</h2>
      {departures.isPending ? <p role="status">{t('offers.departures.loading')}</p> : null}
      {departures.isError ? (
        <Alert tone="error">
          <p>{t('offers.departures.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void departures.refetch()}
          >
            {t('offers.retry')}
          </button>
        </Alert>
      ) : null}
      {departures.isSuccess && departures.data.length === 0 ? (
        <p className="muted">{t('offers.departures.empty')}</p>
      ) : null}
      {departures.isSuccess && departures.data.length > 0 ? (
        <ul className="stack">
          {departures.data.map((departure) => (
            <DepartureRow
              key={departure.id}
              teamId={teamId}
              departure={departure}
              seats={seats}
              roles={roles}
              canDecide={canDecide}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
