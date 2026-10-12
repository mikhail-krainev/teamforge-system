'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { describeError, invalidFields } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { t } from '@/i18n';
import { PROFILE_KEY, saveMyProfile, type CatalogEntry } from './api';
import { ConflictPanel } from './ConflictPanel';
import { currentFromConflict, isVersionConflict } from './conflict';
import { toInput, validateDraft, type DraftErrors, type Profile, type ProfileDraft } from './model';
import { ProfileFields } from './ProfileFormSections';

interface Props {
  initial: ProfileDraft;
  /** Version of the stored profile; `null` before the first save. */
  version: number | null;
  roles: readonly CatalogEntry[];
  tags: readonly CatalogEntry[];
  /** Called when the user picks the server's current data after a conflict. */
  onAdoptCurrent: (current: Profile) => void;
}

/** `saveMyProfile` with an idempotency key per intent; remembers the version of the last save. */
function useProfileSave(version: number | null) {
  const queryClient = useQueryClient();
  const [baseVersion, setBaseVersion] = useState(version);
  const [saved, setSaved] = useState(false);
  const mutation = useIdempotentMutation({
    mutationFn: (input: ReturnType<typeof toInput>, key) => saveMyProfile(input, key),
    onSuccess: (profile) => {
      queryClient.setQueryData(PROFILE_KEY, profile);
      setBaseVersion(profile.version);
      setSaved(true);
    },
  });
  return { mutation, baseVersion, saved, markDirty: () => setSaved(false) };
}

function fieldErrorLookup(errors: DraftErrors, serverInvalid: ReadonlySet<string>) {
  return (name: string): string | undefined => {
    const key = errors[name];
    if (key) return t(key);
    return serverInvalid.has(name) ? t('errors.codes.VALIDATION_FAILED') : undefined;
  };
}

export function ProfileForm({ initial, version, roles, tags, onAdoptCurrent }: Props) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const { mutation: save, baseVersion, saved, markDirty } = useProfileSave(version);

  const patch = (change: Partial<ProfileDraft>) => {
    markDirty();
    setDraft((prev) => ({ ...prev, ...change }));
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate(toInput(draft, baseVersion));
  }

  const conflict = isVersionConflict(save.error);
  const serverInvalid = save.isError && !conflict ? invalidFields(save.error) : new Set<string>();
  const fieldError = fieldErrorLookup(errors, serverInvalid);

  return (
    <form onSubmit={submit} noValidate className="stack" aria-label={t('profile.page.title')}>
      {conflict ? (
        <ConflictPanel
          current={currentFromConflict(save.error)}
          onOverwrite={(current) => save.mutate(toInput(draft, current.version))}
          onAdopt={onAdoptCurrent}
          busy={save.isPending}
        />
      ) : null}
      <ProfileFields
        draft={draft}
        patch={patch}
        errors={errors}
        fieldError={fieldError}
        roles={roles}
        tags={tags}
      />
      {Object.keys(errors).length > 0 ? (
        <Alert tone="error">{t('profile.form.fixErrors')}</Alert>
      ) : null}
      {save.isError && !conflict ? <Alert tone="error">{describeError(save.error)}</Alert> : null}
      <div className="row">
        <button type="submit" className="button" disabled={save.isPending}>
          {save.isPending ? t('profile.form.saving') : t('profile.form.save')}
        </button>
        <span role="status" aria-live="polite">
          {saved ? t('profile.form.saved') : ''}
        </span>
      </div>
    </form>
  );
}
