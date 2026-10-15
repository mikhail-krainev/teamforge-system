'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import type { CatalogEntry } from '@/features/profile/api';
import type { Seat } from '@/features/teams/api';
import { useFocusInvalid } from '@/features/teams/useFocusInvalid';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { createJoinRequest, MY_OFFERS_KEY, type JoinRequestCreate } from './api';
import { ActionErrorAlert } from './ActionErrorAlert';
import { SeatSelectField } from './SeatSelectField';

interface Props {
  teamId: string;
  seats: readonly Seat[];
  roles: readonly CatalogEntry[];
}

interface Errors {
  seat?: string;
  message?: string;
}

function useJoinRequest(teamId: string) {
  const queryClient = useQueryClient();
  const [seatId, setSeatId] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const focus = useFocusInvalid();
  const send = useIdempotentMutation({
    mutationFn: (body: JoinRequestCreate, key) => createJoinRequest(teamId, body, key),
    onSuccess: async () => {
      setMessage('');
      await queryClient.invalidateQueries({ queryKey: MY_OFFERS_KEY });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const found: Errors = {};
    if (!seatId) found.seat = t('offers.request.errors.seat');
    if (message.length > 500) found.message = t('offers.request.errors.message');
    setErrors(found);
    if (found.seat) focus('request-seat');
    else if (found.message) focus('request-message');
    else send.mutate({ seatId, ...(message.trim() ? { message: message.trim() } : {}) });
  }
  return { seatId, setSeatId, message, setMessage, errors, send, submit };
}

function SentNotice() {
  return (
    <Alert tone="success">
      {t('offers.request.sent')} <Link href="/offers">{t('offers.request.myOffers')}</Link>
    </Alert>
  );
}

/** A candidate asks the lead for an open seat (createJoinRequest). */
export function JoinRequestForm({ teamId, seats, roles }: Props) {
  const form = useJoinRequest(teamId);
  const { send, errors } = form;
  const openSeats = seats.filter((s) => s.status === 'open');
  if (openSeats.length === 0) return null;
  return (
    <form
      onSubmit={form.submit}
      noValidate
      className="card stack"
      aria-labelledby="request-form-heading"
    >
      <h2 id="request-form-heading">{t('offers.request.title')}</h2>
      <p className="muted">{t('offers.request.lead')}</p>
      <SeatSelectField
        id="request-seat"
        label={t('offers.request.seat')}
        placeholder={t('offers.request.seatPick')}
        value={form.seatId}
        error={errors.seat}
        openSeats={openSeats}
        roles={roles}
        onChange={form.setSeatId}
      />
      <Field
        id="request-message"
        label={t('offers.request.message')}
        hint={t('offers.request.messageHint')}
        error={errors.message}
      >
        {(c) => (
          <textarea
            {...c}
            rows={3}
            value={form.message}
            onChange={(e) => form.setMessage(e.target.value)}
          />
        )}
      </Field>
      {send.isError ? <ActionErrorAlert error={send.error} /> : null}
      {send.isSuccess ? <SentNotice /> : null}
      <div>
        <button type="submit" className="button" disabled={send.isPending}>
          {send.isPending ? t('offers.request.sending') : t('offers.request.send')}
        </button>
      </div>
    </form>
  );
}
