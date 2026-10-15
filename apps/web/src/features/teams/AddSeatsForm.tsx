'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { CatalogEntry } from '@/features/profile/api';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { addSeats, teamKey, type SeatInput } from './api';
import {
  emptySeat,
  firstInvalidId,
  toSeatInput,
  validateSeat,
  type DraftErrors,
  type SeatDraft,
} from './model';
import { SeatDraftFields } from './SeatDraftFields';
import { TeamErrorAlert } from './TeamErrorAlert';
import { useFocusInvalid } from './useFocusInvalid';

const ORDER = ['new-seat-roleCode', 'new-seat-minHours', 'new-seat-count'];

/** `addSeats` for the lead: one batch per submit, one idempotency key per batch. */
function useAddSeats(teamId: string, onDone: () => void) {
  const queryClient = useQueryClient();
  const [seat, setSeat] = useState<SeatDraft>(emptySeat);
  const [errors, setErrors] = useState<DraftErrors>({});
  const focus = useFocusInvalid();
  const refresh = () => queryClient.invalidateQueries({ queryKey: teamKey(teamId) });
  const add = useIdempotentMutation({
    mutationFn: (seats: SeatInput[], key) => addSeats(teamId, seats, key),
    onSuccess: async () => {
      await refresh();
      setSeat(emptySeat());
      onDone();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateSeat(seat, 'new-seat');
    setErrors(found);
    const invalid = firstInvalidId(found, ORDER);
    if (invalid) focus(invalid);
    else add.mutate([toSeatInput(seat)]);
  }
  return { seat, setSeat, errors, add, submit, refresh };
}

interface Props {
  teamId: string;
  roles: readonly CatalogEntry[];
}

export function AddSeatsForm({ teamId, roles }: Props) {
  const [open, setOpen] = useState(false);
  const { seat, setSeat, errors, add, submit, refresh } = useAddSeats(teamId, () => setOpen(false));
  if (!open) {
    return (
      <div>
        <button type="button" className="button" onClick={() => setOpen(true)}>
          {t('teams.detail.addSeats')}
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate className="stack" aria-label={t('teams.detail.addSeats')}>
      <SeatDraftFields
        prefix="new-seat"
        position={1}
        seat={seat}
        roles={roles}
        error={(id) => (errors[id] ? t(errors[id]) : undefined)}
        onChange={(change) => setSeat((prev) => ({ ...prev, ...change }))}
        onRemove={() => setOpen(false)}
      />
      {add.isError ? <TeamErrorAlert error={add.error} onRefresh={() => void refresh()} /> : null}
      <div className="row">
        <button type="submit" className="button" disabled={add.isPending}>
          {add.isPending ? t('teams.detail.addingSeats') : t('teams.detail.addSeatsSubmit')}
        </button>
      </div>
    </form>
  );
}
