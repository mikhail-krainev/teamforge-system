'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import type { CatalogEntry } from '@/features/profile/api';
import { browserTimezone } from '@/features/profile/TimezoneSelect';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import { invalidFields } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { createTeam, teamKey } from './api';
import './teams.css';
import { CreateTeamFields } from './CreateTeamFields';
import {
  emptySeat,
  emptyTeamDraft,
  firstInvalidId,
  toTeamCreate,
  validateTeamDraft,
  type DraftErrors,
  type TeamDraft,
} from './model';
import { useProductTypes } from './queries';
import { SeatDraftFields } from './SeatDraftFields';
import { TeamErrorAlert } from './TeamErrorAlert';
import { useFocusInvalid } from './useFocusInvalid';

const FIELD_ORDER = ['name', 'description', 'productTypeCode', 'timezone', 'hoursPerWeek'];

function orderFor(draft: TeamDraft): string[] {
  const seatIds = draft.seats.flatMap((_, i) => [
    `seat-${i}-roleCode`,
    `seat-${i}-minHours`,
    `seat-${i}-count`,
  ]);
  return [...FIELD_ORDER, ...seatIds];
}

function useCreateMutation(focus: (id: string | undefined) => void) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (input: ReturnType<typeof toTeamCreate>, key) => createTeam(input, key),
    onSuccess: (team) => {
      queryClient.setQueryData(teamKey(team.id), team);
      void queryClient.invalidateQueries({ queryKey: ['teams', 'list'] });
      router.push(`/teams/${team.id}`);
    },
    onError: (error) => focus(FIELD_ORDER.find((id) => invalidFields(error).has(id))),
  });
}

function useCreateTeamForm() {
  const [draft, setDraft] = useState(() => emptyTeamDraft(browserTimezone()));
  const [errors, setErrors] = useState<DraftErrors>({});
  const focus = useFocusInvalid();
  const create = useCreateMutation(focus);
  const patch = (change: Partial<TeamDraft>) => setDraft((prev) => ({ ...prev, ...change }));
  const serverInvalid = create.isError ? invalidFields(create.error) : new Set<string>();
  const fieldError = (id: string) => {
    const key = errors[id];
    if (key) return t(key);
    return serverInvalid.has(id) ? t('errors.codes.VALIDATION_FAILED') : undefined;
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateTeamDraft(draft);
    setErrors(found);
    const invalid = firstInvalidId(found, orderFor(draft));
    if (invalid) focus(invalid);
    else if (Object.keys(found).length === 0) create.mutate(toTeamCreate(draft));
  }
  return { draft, patch, errors, create, fieldError, submit };
}

interface SeatsProps {
  draft: TeamDraft;
  roles: readonly CatalogEntry[];
  error: string | undefined;
  fieldError: (id: string) => string | undefined;
  patch: (change: Partial<TeamDraft>) => void;
}

function SeatsSection({ draft, roles, error, fieldError, patch }: SeatsProps) {
  const patchSeat = (index: number, change: Partial<TeamDraft['seats'][number]>) =>
    patch({ seats: draft.seats.map((s, i) => (i === index ? { ...s, ...change } : s)) });
  return (
    <section className="stack" aria-labelledby="create-seats-heading">
      <h2 id="create-seats-heading">{t('teams.create.seatsTitle')}</h2>
      <p className="muted">{t('teams.create.seatsHint')}</p>
      {draft.seats.map((seat, index) => (
        <SeatDraftFields
          key={index}
          prefix={`seat-${index}`}
          position={index + 1}
          seat={seat}
          roles={roles}
          error={fieldError}
          onChange={(change) => patchSeat(index, change)}
          onRemove={() => patch({ seats: draft.seats.filter((_, i) => i !== index) })}
        />
      ))}
      {error ? <p className="field-error">{error}</p> : null}
      <div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => patch({ seats: [...draft.seats, emptySeat()] })}
        >
          {t('teams.create.addSeat')}
        </button>
      </div>
    </section>
  );
}

/** What the team will look like in the list; fills in while the form is typed. */
function TeamPreview({ draft, roles }: { draft: TeamDraft; roles: readonly CatalogEntry[] }) {
  const seatCount = draft.seats.reduce((sum, seat) => sum + (Number(seat.count) || 0), 0);
  const roleNames = draft.seats
    .map((seat) => roles.find((r) => r.code === seat.roleCode)?.name)
    .filter((name): name is string => Boolean(name));
  return (
    <aside className="create-preview" aria-hidden="true">
      <span className="section-mark">{t('teams.create.previewTitle')}</span>
      <div className="team-row">
        <div>
          <h3>{draft.name.trim() || t('teams.create.previewName')}</h3>
          <p className="muted">{draft.description.trim() || t('teams.create.previewPitch')}</p>
        </div>
        <div className="team-seats">
          <span className="mono">{t('teams.create.previewSeats', { count: seatCount })}</span>
          <span className="seat-grid">
            {Array.from({ length: Math.min(seatCount, 12) }, (_, index) => (
              <i key={index} />
            ))}
          </span>
        </div>
        <ul className="tag-list">
          {[...new Set(roleNames)].map((name) => (
            <li key={name} className="tag">
              {name}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function CreateTeamFormBody({ roles }: { roles: readonly CatalogEntry[] }) {
  const types = useProductTypes();
  const { draft, patch, errors, create, fieldError, submit } = useCreateTeamForm();
  return (
    <div className="grid-2">
      <form onSubmit={submit} noValidate className="stack" aria-label={t('teams.create.title')}>
        <CreateTeamFields
          draft={draft}
          patch={patch}
          fieldError={fieldError}
          productTypes={types.data ?? []}
        />
        <SeatsSection
          draft={draft}
          roles={roles}
          error={errors.seats ? t(errors.seats) : undefined}
          fieldError={fieldError}
          patch={patch}
        />
        {Object.keys(errors).length > 0 ? (
          <Alert tone="error">{t('teams.create.fixErrors')}</Alert>
        ) : null}
        {create.isError ? <TeamErrorAlert error={create.error} /> : null}
        <div className="row">
          <button type="submit" className="button" disabled={create.isPending || create.isSuccess}>
            {create.isPending ? t('teams.create.submitting') : t('teams.create.submit')}
          </button>
        </div>
      </form>
      <TeamPreview draft={draft} roles={roles} />
    </div>
  );
}

export function CreateTeamForm() {
  const roles = useRoles();
  const types = useProductTypes();
  if (types.isError || roles.isError) {
    return <Alert tone="error">{t('teams.create.loadFailed')}</Alert>;
  }
  if (types.isPending || roles.isPending) {
    return (
      <div className="row">
        <Yeti pose="think" size={96} />
        <p role="status" className="mono muted">
          {t('teams.create.loading')}
        </p>
      </div>
    );
  }
  return <CreateTeamFormBody roles={roles.data} />;
}
