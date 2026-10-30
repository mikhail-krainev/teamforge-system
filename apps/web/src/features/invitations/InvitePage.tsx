'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';
import { LoadingState } from '@/components/ui/LoadingState';
import { useMe } from '@/features/auth/session';
import { stripFragment } from '@/features/auth/fragment';
import { ActionErrorAlert } from '@/features/offers/ActionErrorAlert';
import { useRoles } from '@/features/profile/useProfileQueries';
import { useProductTypes } from '@/features/teams/queries';
import { t } from '@/i18n';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { acceptInvitation, previewInvitation, type InvitationPreview } from './api';
import { readInviteToken } from './token';

/** Reads the token from the fragment once and removes the fragment from the address bar at once. */
function useInviteToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const read = useRef(false);
  useEffect(() => {
    if (read.current) return; // React StrictMode runs effects twice
    read.current = true;
    setToken(readInviteToken(window.location.hash));
    stripFragment();
  }, []);
  return token;
}

/** A definitive answer (410, 403, 404, 422) cannot change on retry; transient failures can. */
function canRetry(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && (error.status >= 500 || error.status === 429);
}

function PreviewDetails({ preview }: { preview: InvitationPreview }) {
  const roles = useRoles();
  const types = useProductTypes();
  const role = roles.data?.find((r) => r.code === preview.roleCode)?.name ?? preview.roleCode;
  const type =
    types.data?.find((p) => p.code === preview.productTypeCode)?.name ?? preview.productTypeCode;
  return (
    <dl className="definition-list">
      <dt>{t('invitations.invite.team')}</dt>
      <dd>{preview.teamName}</dd>
      <dt>{t('invitations.invite.role')}</dt>
      <dd>{role}</dd>
      <dt>{t('invitations.invite.productType')}</dt>
      <dd>{type}</dd>
      <dt>{t('invitations.invite.expires')}</dt>
      <dd>{new Date(preview.expiresAt).toLocaleString('ru-RU')}</dd>
    </dl>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="page-narrow">
      <header className="page-head">
        <h1>{t('invitations.invite.title')}</h1>
      </header>
      <div className="card stack">{children}</div>
    </div>
  );
}

function Joined({ teamId }: { teamId: string }) {
  return (
    <>
      <Alert tone="success">{t('invitations.invite.joined')}</Alert>
      <div>
        <Link href={`/teams/${teamId}`} className="button">
          {t('invitations.invite.toTeam')}
        </Link>
      </div>
    </>
  );
}

interface PreviewErrorProps {
  error: unknown;
  pending: boolean;
  onRetry: () => void;
}

function PreviewFailed({ error, pending, onRetry }: PreviewErrorProps) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <Shell>
      {notFound ? (
        <Alert tone="error">{t('invitations.invite.notFound')}</Alert>
      ) : (
        <ActionErrorAlert error={error} />
      )}
      {canRetry(error) ? (
        <div>
          <button type="button" className="button" disabled={pending} onClick={onRetry}>
            {t('invitations.invite.retry')}
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

function Waiting({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <Shell>
      <LoadingState text={text} spinner={spinner ?? false} />
    </Shell>
  );
}

function Guest() {
  return (
    <Shell>
      <Alert tone="info">{t('invitations.invite.guest')}</Alert>
      <div>
        <Link href="/sign-in" className="button">
          {t('invitations.invite.signIn')}
        </Link>
      </div>
    </Shell>
  );
}

/** Token, session, the one-time preview and the idempotent acceptance of the invitation. */
function useInviteFlow() {
  const queryClient = useQueryClient();
  const token = useInviteToken();
  const me = useMe();
  const preview = useMutation({ mutationFn: (value: string) => previewInvitation(value) });
  const accept = useIdempotentMutation({
    mutationFn: (value: string, key) => acceptInvitation(value, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams'] }),
  });
  const started = useRef(false);
  const signedIn = Boolean(me.data);
  const { mutate: startPreview } = preview;
  useEffect(() => {
    if (!token || !signedIn || started.current) return;
    started.current = true;
    startPreview(token);
  }, [token, signedIn, startPreview]);
  return { token, me, preview, accept };
}

/** `/invite#<token>`: the token is read from the fragment, previewed, then accepted on request. */
export function InvitePage() {
  const { token, me, preview, accept } = useInviteFlow();

  if (token === undefined) return <Waiting text={t('invitations.invite.reading')} />;
  if (token === null) {
    return (
      <Shell>
        <Alert tone="error">{t('invitations.invite.missing')}</Alert>
      </Shell>
    );
  }
  if (me.isPending) return <Waiting text={t('invitations.invite.loadingSession')} />;
  if (!me.data) return <Guest />;
  if (accept.isSuccess) {
    return (
      <Shell>
        <Joined teamId={accept.data.teamId} />
      </Shell>
    );
  }
  if (preview.isError) {
    return (
      <PreviewFailed
        error={preview.error}
        pending={preview.isPending}
        onRetry={() => preview.mutate(token)}
      />
    );
  }
  if (!preview.data) return <Waiting text={t('invitations.invite.previewing')} spinner />;
  return (
    <Shell>
      <PreviewDetails preview={preview.data} />
      {accept.isError ? <ActionErrorAlert error={accept.error} /> : null}
      <div>
        <button
          type="button"
          className="button"
          disabled={accept.isPending}
          onClick={() => accept.mutate(token)}
        >
          {accept.isPending ? t('invitations.invite.accepting') : t('invitations.invite.accept')}
        </button>
      </div>
    </Shell>
  );
}
