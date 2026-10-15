'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import type { CatalogEntry } from '@/features/profile/api';
import type { Seat } from '@/features/teams/api';
import { useFocusInvalid } from '@/features/teams/useFocusInvalid';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { createOffer, teamOffersKey, type SeatOfferCreate } from './api';
import { ActionErrorAlert } from './ActionErrorAlert';
import { SeatSelectField } from './SeatSelectField';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_MAX = 500;

type FieldName = 'seat' | 'userId' | 'message';
type Errors = Partial<Record<FieldName, string>>;
interface Draft {
  seatId: string;
  userId: string;
  message: string;
}

function validate({ seatId, userId, message }: Draft): Errors {
  const errors: Errors = {};
  if (!seatId) errors.seat = t('offers.compose.errors.seat');
  if (!UUID.test(userId.trim())) errors.userId = t('offers.compose.errors.userId');
  if (message.length > MESSAGE_MAX) errors.message = t('offers.compose.errors.message');
  return errors;
}

/** Form state and the createOffer mutation: one idempotency key per intent, retry reuses it. */
function useOfferForm(teamId: string) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ seatId: '', userId: '', message: '' });
  const [errors, setErrors] = useState<Errors>({});
  const focus = useFocusInvalid();
  const send = useIdempotentMutation({
    mutationFn: (body: SeatOfferCreate, key) => createOffer(teamId, body, key),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamOffersKey(teamId) });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate(draft);
    setErrors(found);
    const first = (['seat', 'userId', 'message'] as const).find((k) => found[k]);
    if (first) return focus(`offer-${first}`);
    const message = draft.message.trim();
    send.mutate({
      seatId: draft.seatId,
      userId: draft.userId.trim(),
      ...(message ? { message } : {}),
    });
  }
  return { draft, setDraft, errors, send, submit };
}

interface FieldsProps {
  draft: Draft;
  errors: Errors;
  openSeats: readonly Seat[];
  roles: readonly CatalogEntry[];
  onChange: (change: Partial<Draft>) => void;
}

function OfferFields({ draft, errors, openSeats, roles, onChange }: FieldsProps) {
  return (
    <>
      {openSeats.length === 0 ? <p className="muted">{t('offers.compose.noOpenSeats')}</p> : null}
      <SeatSelectField
        id="offer-seat"
        label={t('offers.compose.seat')}
        placeholder={t('offers.compose.seatPick')}
        value={draft.seatId}
        error={errors.seat}
        openSeats={openSeats}
        roles={roles}
        onChange={(seatId) => onChange({ seatId })}
      />
      <Field
        id="offer-userId"
        label={t('offers.compose.userId')}
        hint={t('offers.compose.userIdHint')}
        error={errors.userId}
        required
      >
        {(c) => (
          <input
            {...c}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={draft.userId}
            onChange={(e) => onChange({ userId: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="offer-message"
        label={t('offers.compose.message')}
        hint={t('offers.compose.messageHint')}
        error={errors.message}
      >
        {(c) => (
          <textarea
            {...c}
            rows={3}
            value={draft.message}
            onChange={(e) => onChange({ message: e.target.value })}
          />
        )}
      </Field>
    </>
  );
}

interface Props {
  teamId: string;
  seats: readonly Seat[];
  roles: readonly CatalogEntry[];
}

function ComposeButtons({ pending, onCancel }: { pending: boolean; onCancel: () => void }) {
  return (
    <div className="row">
      <button type="submit" className="button" disabled={pending}>
        {pending ? t('offers.compose.sending') : t('offers.compose.send')}
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={pending}
        onClick={onCancel}
      >
        {t('offers.compose.cancel')}
      </button>
    </div>
  );
}

/** The lead offers an open seat to a user. */
export function OfferComposer({ teamId, seats, roles }: Props) {
  const [open, setOpen] = useState(false);
  const { draft, setDraft, errors, send, submit } = useOfferForm(teamId);
  const sent = send.isSuccess ? <Alert tone="success">{t('offers.compose.sent')}</Alert> : null;
  if (!open) {
    return (
      <div className="stack">
        {sent}
        <div>
          <button
            type="button"
            className="button"
            onClick={() => {
              send.reset();
              setOpen(true);
            }}
          >
            {t('offers.compose.open')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="card stack"
      aria-label={t('offers.compose.title')}
    >
      <OfferFields
        draft={draft}
        errors={errors}
        openSeats={seats.filter((s) => s.status === 'open')}
        roles={roles}
        onChange={(change) => setDraft((prev) => ({ ...prev, ...change }))}
      />
      {send.isError ? <ActionErrorAlert error={send.error} /> : null}
      {sent}
      <ComposeButtons pending={send.isPending} onCancel={() => setOpen(false)} />
    </form>
  );
}
