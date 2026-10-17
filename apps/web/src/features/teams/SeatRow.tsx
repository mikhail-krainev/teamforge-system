'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { closeSeat, teamKey, updateSeat, type Level, type Seat, type SeatPatch } from './api';
import { LEVELS, LIMITS, levelLabel } from './model';
import { TeamErrorAlert } from './TeamErrorAlert';
import { useFocusInvalid } from './useFocusInvalid';

interface Props {
  teamId: string;
  seat: Seat;
  roleName: string;
  holderName: string | undefined;
  canManage: boolean;
}

function isHoursValid(value: string): boolean {
  const n = Number(value);
  return /^\d+$/.test(value.trim()) && n >= LIMITS.hoursMin && n <= LIMITS.hoursMax;
}

/** Seat mutations share one cache refresh; each button owns its idempotency key (one per intent). */
function useSeatActions(teamId: string, seat: Seat, onSaved: () => void) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: teamKey(teamId) });
  const update = useIdempotentMutation({
    mutationFn: (patch: SeatPatch, key) => updateSeat(teamId, seat.id, patch, key),
    onSuccess: async () => {
      await refresh();
      onSaved();
    },
  });
  const close = useIdempotentMutation({
    mutationFn: (_: void, key) => closeSeat(teamId, seat.id, key),
    onSuccess: refresh,
  });
  return { update, close, refresh };
}

function SeatInfo({ seat, roleName, holderName }: Pick<Props, 'seat' | 'roleName' | 'holderName'>) {
  const detail = [
    levelLabel(seat.minLevel),
    t('teams.seat.hoursShort', { hours: seat.minHours }),
    t(`teams.seat.status.${seat.status}`),
    seat.desired ? t('teams.seat.desiredBadge') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <h3>{roleName}</h3>
      <p className="muted">{detail}</p>
      {holderName ? <p>{t('teams.seat.holder', { name: holderName })}</p> : null}
      {seat.stack.length > 0 ? (
        <ul className="tag-list" aria-label={t('teams.seat.stack')}>
          {seat.stack.map((tag) => (
            <li key={tag} className="tag">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

interface ButtonsProps {
  seat: Seat;
  busy: boolean;
  closing: boolean;
  onEdit: () => void;
  onToggleDesired: () => void;
  onClose: () => void;
}

function SeatButtons({ seat, busy, closing, onEdit, onToggleDesired, onClose }: ButtonsProps) {
  return (
    <div className="row">
      <button type="button" className="button button-secondary" disabled={busy} onClick={onEdit}>
        {t('teams.seat.edit')}
      </button>
      <button
        type="button"
        className="button button-secondary"
        aria-pressed={seat.desired}
        disabled={busy}
        onClick={onToggleDesired}
      >
        {seat.desired ? t('teams.seat.unmarkDesired') : t('teams.seat.markDesired')}
      </button>
      <button type="button" className="button button-danger" disabled={busy} onClick={onClose}>
        {closing ? t('teams.seat.closing') : t('teams.seat.close')}
      </button>
    </div>
  );
}

export function SeatRow({ teamId, seat, roleName, holderName, canManage }: Props) {
  const [editing, setEditing] = useState(false);
  const { update, close, refresh } = useSeatActions(teamId, seat, () => setEditing(false));
  const error = update.error ?? close.error;
  return (
    <li className="card stack">
      <SeatInfo seat={seat} roleName={roleName} holderName={holderName} />
      {error ? <TeamErrorAlert error={error} onRefresh={() => void refresh()} /> : null}
      {canManage && seat.status === 'open' && !editing ? (
        <SeatButtons
          seat={seat}
          busy={update.isPending || close.isPending}
          closing={close.isPending}
          onEdit={() => setEditing(true)}
          onToggleDesired={() => update.mutate({ version: seat.version, desired: !seat.desired })}
          onClose={() => close.mutate()}
        />
      ) : null}
      {canManage && seat.status === 'open' ? (
        <p>
          <Link href={`/teams/${teamId}/seats/${seat.id}`}>{t('matching.candidates.open')}</Link>
        </p>
      ) : null}
      {editing ? (
        <SeatEditForm
          seat={seat}
          pending={update.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(patch) => update.mutate(patch)}
        />
      ) : null}
    </li>
  );
}

interface EditProps {
  seat: Seat;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (patch: SeatPatch) => void;
}

interface EditFieldsProps {
  seatId: string;
  level: Level;
  hours: string;
  desired: boolean;
  invalid: boolean;
  onLevel: (value: Level) => void;
  onHours: (value: string) => void;
  onDesired: (value: boolean) => void;
}

function EditFields(props: EditFieldsProps) {
  const { seatId, level, hours, desired, invalid } = props;
  return (
    <>
      <Field id={`seat-${seatId}-edit-level`} label={t('teams.seat.minLevel')}>
        {(c) => (
          <select {...c} value={level} onChange={(e) => props.onLevel(e.target.value as Level)}>
            {LEVELS.map((item) => (
              <option key={item} value={item}>
                {levelLabel(item)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        id={editHoursId(seatId)}
        label={t('teams.seat.minHours')}
        hint={t('teams.seat.minHoursHint')}
        error={invalid ? t('teams.errors.hours') : undefined}
        required
      >
        {(c) => (
          <input
            {...c}
            type="number"
            inputMode="numeric"
            min={LIMITS.hoursMin}
            max={LIMITS.hoursMax}
            value={hours}
            onChange={(e) => props.onHours(e.target.value)}
          />
        )}
      </Field>
      <label className="row">
        <input
          type="checkbox"
          checked={desired}
          onChange={(e) => props.onDesired(e.target.checked)}
        />
        <span>{t('teams.seat.desired')}</span>
      </label>
    </>
  );
}

const editHoursId = (seatId: string) => `seat-${seatId}-edit-hours`;

function SeatEditForm({ seat, pending, onCancel, onSubmit }: EditProps) {
  const [level, setLevel] = useState<Level>(seat.minLevel);
  const [hours, setHours] = useState(String(seat.minHours));
  const [desired, setDesired] = useState(seat.desired);
  const [invalid, setInvalid] = useState(false);
  const focus = useFocusInvalid();

  function submit(event: FormEvent) {
    event.preventDefault();
    const bad = !isHoursValid(hours);
    setInvalid(bad);
    if (bad) focus(editHoursId(seat.id));
    else onSubmit({ version: seat.version, minLevel: level, minHours: Number(hours), desired });
  }

  return (
    <form onSubmit={submit} noValidate className="stack" aria-label={t('teams.seat.editTitle')}>
      <EditFields
        seatId={seat.id}
        level={level}
        hours={hours}
        desired={desired}
        invalid={invalid}
        onLevel={setLevel}
        onHours={setHours}
        onDesired={setDesired}
      />
      <div className="row">
        <button type="submit" className="button" disabled={pending}>
          {pending ? t('teams.seat.saving') : t('teams.seat.save')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={onCancel}
        >
          {t('teams.seat.cancel')}
        </button>
      </div>
    </form>
  );
}
