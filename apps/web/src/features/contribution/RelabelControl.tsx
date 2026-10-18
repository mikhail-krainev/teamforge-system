'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { hasMessage, t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { ApiError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { feedRootKey, relabelContribution, type FeedEntry } from './api';
import type { RoleNameOf } from './model';

interface Props {
  teamId: string;
  entry: Pick<FeedEntry, 'id' | 'title' | 'roleCode'>;
  /** Roles the participant holds in this team (FR-WORK-17: only own roles). */
  roleCodes: readonly string[];
  roleName: RoleNameOf;
}

function relabelErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `feed.relabel.errors.${error.code}`;
    if (hasMessage(key)) return t(key);
    if (error.status === 409 || error.status === 422) return t('feed.relabel.errors.unknown');
  }
  return describeError(error);
}

function useRelabel(teamId: string, contributionId: string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (roleCode: string, key) =>
      relabelContribution(teamId, { contributionId, roleCode }, key),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: feedRootKey(teamId) });
      onDone();
    },
    onError: () => queryClient.invalidateQueries({ queryKey: feedRootKey(teamId) }),
  });
}

function ConfirmButtons({
  pending,
  canConfirm,
  onConfirm,
  onCancel,
}: {
  pending: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="row">
      <button
        type="button"
        className="button"
        disabled={pending || !canConfirm}
        onClick={onConfirm}
      >
        {pending ? t('feed.relabel.confirming') : t('feed.relabel.confirm')}
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={pending}
        onClick={onCancel}
      >
        {t('feed.relabel.cancel')}
      </button>
    </div>
  );
}

function RelabelPanel({
  teamId,
  entry,
  roleCodes,
  roleName,
  onClose,
}: Props & { onClose: () => void }) {
  const id = useId();
  const choices = roleCodes.filter((code) => code !== entry.roleCode);
  const [roleCode, setRoleCode] = useState(choices[0] ?? '');
  const mutation = useRelabel(teamId, entry.id, onClose);
  return (
    <div className="card nested stack" role="group" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{t('feed.relabel.title')}</h4>
      <Field id={`${id}-role`} label={t('feed.relabel.role')} hint={t('feed.relabel.hint')}>
        {(control) => (
          <select
            {...control}
            value={roleCode}
            disabled={mutation.isPending}
            onChange={(event) => setRoleCode(event.target.value)}
          >
            {choices.map((code) => (
              <option key={code} value={code}>
                {roleName(code)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p>{t('feed.relabel.confirmText', { title: entry.title, role: roleName(roleCode) })}</p>
      {mutation.isError ? <Alert tone="error">{relabelErrorText(mutation.error)}</Alert> : null}
      <ConfirmButtons
        pending={mutation.isPending}
        canConfirm={roleCode !== ''}
        onConfirm={() => mutation.mutate(roleCode)}
        onCancel={onClose}
      />
    </div>
  );
}

/**
 * "Сменить роль" on the participant's own contribution (FR-WORK-17): the new role is chosen from the
 * roles the participant holds and saved only after a confirmation. Nothing is offered for a single role.
 */
export function RelabelControl(props: Props) {
  const [open, setOpen] = useState(false);
  const hasChoice = props.roleCodes.some((code) => code !== props.entry.roleCode);
  if (!hasChoice) return null;
  if (open) return <RelabelPanel {...props} onClose={() => setOpen(false)} />;
  return (
    <div>
      <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
        {t('feed.relabel.button')}
      </button>
    </div>
  );
}
