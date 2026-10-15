'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { useMe } from '@/features/auth/session';
import { ActionErrorAlert } from '@/features/offers/ActionErrorAlert';
import { SeatSelectField } from '@/features/offers/SeatSelectField';
import type { CatalogEntry } from '@/features/profile/api';
import { useRoles } from '@/features/profile/useProfileQueries';
import type { Seat } from '@/features/teams/api';
import { useTeam } from '@/features/teams/queries';
import { useFocusInvalid } from '@/features/teams/useFocusInvalid';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import {
  createInvitation,
  invitationsKey,
  revokeInvitation,
  type Invitation,
  type InvitationCreate,
} from './api';
import { useInvitations } from './queries';
import { inviteLink } from './token';

const GITHUB = /^[A-Za-z0-9-]{1,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = Partial<Record<'seat' | 'github' | 'email', string>>;

interface Draft {
  seatId: string;
  github: string;
  email: string;
}

/** The link is shown once, right after creation; closing it forgets the token. */
function CreatedLink({ link, onDismiss }: { link: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }
  return (
    <section className="card stack" aria-labelledby="invite-link-heading">
      <h2 id="invite-link-heading">{t('invitations.link.title')}</h2>
      <Alert tone="warn">{t('invitations.link.once')}</Alert>
      <Field id="invite-link" label={t('invitations.link.label')}>
        {(c) => (
          <input
            {...c}
            type="text"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </Field>
      <div className="row">
        <button type="button" className="button" onClick={() => void copy()}>
          {t('invitations.link.copy')}
        </button>
        <button type="button" className="button button-secondary" onClick={onDismiss}>
          {t('invitations.link.dismiss')}
        </button>
      </div>
      <p role="status" className="muted">
        {copied === 'ok' ? t('invitations.link.copied') : ''}
        {copied === 'failed' ? t('invitations.link.copyFailed') : ''}
      </p>
    </section>
  );
}

function validate(seatValue: string, draft: Draft): Errors {
  const found: Errors = {};
  if (!seatValue) found.seat = t('invitations.create.errors.seat');
  if (draft.github.trim() && !GITHUB.test(draft.github.trim())) {
    found.github = t('invitations.create.errors.github');
  }
  if (draft.email.trim() && !EMAIL.test(draft.email.trim())) {
    found.email = t('invitations.create.errors.email');
  }
  return found;
}

/** Draft, validation and the createInvitation mutation (one idempotency key per intent). */
function useCreateInvitation(teamId: string, firstOpenSeat: string) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ seatId: '', github: '', email: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [link, setLink] = useState<string | null>(null);
  const focus = useFocusInvalid();
  // The first open seat is preselected: most invitations fill the next free seat.
  const seatValue = draft.seatId || firstOpenSeat;
  const create = useIdempotentMutation({
    mutationFn: (body: InvitationCreate, key) => createInvitation(teamId, body, key),
    onSuccess: async (created) => {
      setLink(inviteLink(window.location.origin, created.token));
      await queryClient.invalidateQueries({ queryKey: invitationsKey(teamId) });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate(seatValue, draft);
    setErrors(found);
    const first = (['seat', 'github', 'email'] as const).find((k) => found[k]);
    if (first) return focus(`invite-${first}`);
    const github = draft.github.trim();
    const email = draft.email.trim();
    create.mutate({
      seatId: seatValue,
      ...(github ? { inviteeGithubLogin: github } : {}),
      ...(email ? { inviteeEmail: email } : {}),
    });
  }
  const dismiss = () => {
    setLink(null);
    create.reset();
  };
  return { draft, setDraft, seatValue, errors, link, create, submit, dismiss };
}

interface FieldsProps {
  draft: Draft;
  seatValue: string;
  errors: Errors;
  openSeats: readonly Seat[];
  roles: readonly CatalogEntry[];
  onChange: (change: Partial<Draft>) => void;
}

interface IdentityProps {
  draft: Draft;
  errors: Errors;
  onChange: (change: Partial<Draft>) => void;
}

function IdentityFields({ draft, errors, onChange }: IdentityProps) {
  return (
    <>
      <Field
        id="invite-github"
        label={t('invitations.create.github')}
        hint={t('invitations.create.githubHint')}
        error={errors.github}
      >
        {(c) => (
          <input
            {...c}
            type="text"
            autoComplete="off"
            value={draft.github}
            onChange={(e) => onChange({ github: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="invite-email"
        label={t('invitations.create.email')}
        hint={t('invitations.create.emailHint')}
        error={errors.email}
      >
        {(c) => (
          <input
            {...c}
            type="email"
            autoComplete="off"
            value={draft.email}
            onChange={(e) => onChange({ email: e.target.value })}
          />
        )}
      </Field>
    </>
  );
}

function CreateFields({ draft, seatValue, errors, openSeats, roles, onChange }: FieldsProps) {
  return (
    <>
      {openSeats.length === 0 ? (
        <p className="muted">{t('invitations.create.noOpenSeats')}</p>
      ) : null}
      <SeatSelectField
        id="invite-seat"
        label={t('invitations.create.seat')}
        placeholder={t('invitations.create.seatPick')}
        value={seatValue}
        error={errors.seat}
        openSeats={openSeats}
        roles={roles}
        onChange={(seatId) => onChange({ seatId })}
      />
      <IdentityFields draft={draft} errors={errors} onChange={onChange} />
    </>
  );
}

interface FormProps {
  teamId: string;
  seats: readonly Seat[];
  roles: readonly CatalogEntry[];
}

function CreateForm({ teamId, seats, roles }: FormProps) {
  const openSeats = seats.filter((s) => s.status === 'open');
  const form = useCreateInvitation(teamId, openSeats[0]?.id ?? '');
  const { create } = form;
  return (
    <div className="stack">
      <form
        onSubmit={form.submit}
        noValidate
        className="card stack"
        aria-label={t('invitations.create.title')}
      >
        <h2>{t('invitations.create.title')}</h2>
        <CreateFields
          draft={form.draft}
          seatValue={form.seatValue}
          errors={form.errors}
          openSeats={openSeats}
          roles={roles}
          onChange={(change) => form.setDraft((prev) => ({ ...prev, ...change }))}
        />
        {create.isError ? <ActionErrorAlert error={create.error} /> : null}
        <div>
          <button type="submit" className="button" disabled={create.isPending}>
            {create.isPending ? t('invitations.create.submitting') : t('invitations.create.submit')}
          </button>
        </div>
      </form>
      {form.link ? <CreatedLink link={form.link} onDismiss={form.dismiss} /> : null}
    </div>
  );
}

function InvitationRow({
  teamId,
  invitation,
  roleName,
}: {
  teamId: string;
  invitation: Invitation;
  roleName: string;
}) {
  const queryClient = useQueryClient();
  const revoke = useIdempotentMutation({
    mutationFn: (_: void, key) => revokeInvitation(teamId, invitation.id, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey(teamId) }),
  });
  const parts = [
    roleName,
    t(`invitations.status.${invitation.status}`),
    t('invitations.page.expires', {
      date: new Date(invitation.expiresAt).toLocaleDateString('ru-RU'),
    }),
    invitation.inviteeHint ? t('invitations.page.for', { hint: invitation.inviteeHint }) : null,
  ].filter(Boolean);
  return (
    <li className="card stack">
      <p>{parts.join(' · ')}</p>
      {revoke.isSuccess ? <Alert tone="success">{t('invitations.page.revoked')}</Alert> : null}
      {revoke.isError ? <ActionErrorAlert error={revoke.error} /> : null}
      {invitation.status === 'active' ? (
        <div>
          <button
            type="button"
            className="button button-danger"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? t('invitations.page.revoking') : t('invitations.page.revoke')}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function InvitationList({ teamId, roles }: { teamId: string; roles: readonly CatalogEntry[] }) {
  const list = useInvitations(teamId);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  return (
    <section className="stack" aria-labelledby="invitations-list-heading">
      <h2 id="invitations-list-heading">{t('invitations.page.listTitle')}</h2>
      {list.isPending ? <p role="status">{t('invitations.page.loading')}</p> : null}
      {list.isError ? (
        <Alert tone="error">
          <p>{t('invitations.page.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void list.refetch()}
          >
            {t('invitations.retry')}
          </button>
        </Alert>
      ) : null}
      {list.isSuccess && items.length === 0 ? (
        <p className="muted">{t('invitations.page.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="stack">
          {items.map((item) => (
            <InvitationRow
              key={item.id}
              teamId={teamId}
              invitation={item}
              roleName={roleName(item.roleCode)}
            />
          ))}
        </ul>
      ) : null}
      {list.hasNextPage ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('invitations.page.loadMore')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function InvitationsPage({ teamId }: { teamId: string }) {
  const team = useTeam(teamId);
  const me = useMe();
  const roles = useRoles();
  const isLead = Boolean(team.data && me.data && team.data.leadUserId === me.data.id);
  const missing = team.error instanceof ApiError && team.error.status === 404;
  return (
    <div className="stack">
      <h1>{t('invitations.page.title')}</h1>
      <p>
        <Link href={`/teams/${teamId}`}>{t('invitations.page.back')}</Link>
      </p>
      <p className="lead">{t('invitations.page.lead')}</p>
      {missing ? <Alert tone="error">{t('teams.detail.notFound')}</Alert> : null}
      {team.data && !isLead && me.data ? (
        <Alert tone="error">{t('teams.errors.codes.NOT_TEAM_LEAD')}</Alert>
      ) : null}
      {isLead && team.data ? (
        <>
          <CreateForm teamId={teamId} seats={team.data.seats} roles={roles.data ?? []} />
          <InvitationList teamId={teamId} roles={roles.data ?? []} />
        </>
      ) : null}
    </div>
  );
}
