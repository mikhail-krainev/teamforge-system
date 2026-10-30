'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
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
  /** Whether the form holds edits that were not saved (the page must not replace them silently). */
  onDirtyChange?: (dirty: boolean) => void;
}

/** `saveMyProfile` with an idempotency key per intent; remembers the version of the last save. */
function useProfileSave(version: number | null, onDirtyChange?: (dirty: boolean) => void) {
  const queryClient = useQueryClient();
  const [baseVersion, setBaseVersion] = useState(version);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const mutation = useIdempotentMutation({
    mutationFn: (input: ReturnType<typeof toInput>, key) => saveMyProfile(input, key),
    onSuccess: (profile) => {
      queryClient.setQueryData(PROFILE_KEY, profile);
      setBaseVersion(profile.version);
      setSaved(true);
      setDirty(false);
    },
  });
  return {
    mutation,
    baseVersion,
    saved,
    dirty,
    markDirty: () => {
      setSaved(false);
      setDirty(true);
    },
  };
}

function fieldErrorLookup(errors: DraftErrors, serverInvalid: ReadonlySet<string>) {
  return (name: string): string | undefined => {
    const key = errors[name];
    if (key) return t(key);
    return serverInvalid.has(name) ? t('errors.codes.VALIDATION_FAILED') : undefined;
  };
}

function useProfileDraft(
  initial: ProfileDraft,
  version: number | null,
  onDirtyChange?: (dirty: boolean) => void,
) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const { mutation: save, baseVersion, saved, markDirty } = useProfileSave(version, onDirtyChange);
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
  return { draft, errors, patch, submit, save, saved };
}

export function ProfileForm({
  initial,
  version,
  roles,
  tags,
  onAdoptCurrent,
  onDirtyChange,
}: Props) {
  const { draft, errors, patch, submit, save, saved } = useProfileDraft(
    initial,
    version,
    onDirtyChange,
  );
  const conflict = isVersionConflict(save.error);
  const serverInvalid = save.isError && !conflict ? invalidFields(save.error) : new Set<string>();
  const fieldError = fieldErrorLookup(errors, serverInvalid);

  return (
    <form
      onSubmit={submit}
      noValidate
      className="profile-form"
      aria-label={t('profile.page.title')}
    >
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
      <FormAlerts
        hasErrors={Object.keys(errors).length > 0}
        saveError={conflict ? null : save.error}
      />
      <SaveRow pending={save.isPending} saved={saved} />
    </form>
  );
}

function FormAlerts({ hasErrors, saveError }: { hasErrors: boolean; saveError: unknown }) {
  return (
    <>
      {hasErrors ? <Alert tone="error">{t('profile.form.fixErrors')}</Alert> : null}
      {saveError ? <Alert tone="error">{describeError(saveError)}</Alert> : null}
    </>
  );
}

function SaveRow({ pending, saved }: { pending: boolean; saved: boolean }) {
  return (
    <div className="row save-bar">
      <button type="submit" className="button" disabled={pending}>
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        {pending ? t('profile.form.saving') : t('profile.form.save')}
      </button>
      <span role="status" aria-live="polite">
        {saved ? t('profile.form.saved') : ''}
      </span>
    </div>
  );
}
