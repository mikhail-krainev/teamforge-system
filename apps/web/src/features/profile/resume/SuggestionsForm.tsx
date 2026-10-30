'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { t } from '@/i18n';
import { fetchMyProfile } from '../api';
import { isVersionConflict } from '../conflict';
import type { Profile } from '../model';
import { useRoles } from '../useProfileQueries';
import { confirmResume, type ResumeUpload } from './api';
import {
  formatSuggestion,
  missingForNewProfile,
  pickConfirmed,
  requiredFieldsFromError,
  suggestedFields,
  type SuggestionField,
} from './suggestions';

interface Props {
  upload: ResumeUpload;
  profileVersion: number | null;
  onConfirmed: (profile: Profile) => void;
  /** The profile changed under us (409): the freshly loaded one is handed over. */
  onConflict: (profile: Profile) => void;
}

interface ConfirmVariables {
  fields: SuggestionField[];
  version: number | null;
  keepFile: boolean;
}

/**
 * `confirmResumeFields` for the ticked fields; on VERSION_CONFLICT it hands over the fresh profile.
 * The upload and `keepFile` are part of the variables: they decide the idempotency key, so a retry
 * with another target or another choice never replays the answer of the first one (S2CR-12).
 */
function useConfirmResume({ upload, onConfirmed, onConflict }: Props) {
  const [conflicted, setConflicted] = useState(false);
  const mutation = useIdempotentMutation({
    mutationFn: (input: ConfirmVariables & { uploadId: string }, key) =>
      confirmResume(
        {
          uploadId: input.uploadId,
          fields: pickConfirmed(upload.suggestions ?? {}, new Set(input.fields)),
          keepFile: input.keepFile,
          profileVersion: input.version,
        },
        key,
      ),
    onSuccess: (profile) => {
      setConflicted(false);
      onConfirmed(profile);
    },
    onError: async (error) => {
      if (!isVersionConflict(error)) return;
      setConflicted(true);
      const latest = await fetchMyProfile().catch(() => null);
      if (latest) onConflict(latest);
    },
  });
  return { mutation, conflicted };
}

function requiredText(fields: SuggestionField[]): string {
  return t('profile.resume.requiredForNew', {
    fields: fields.map((field) => t(`profile.resume.field.${field}`)).join(', '),
  });
}

/** A 422 about a new profile names the fields; any other failure keeps the generic text. */
function confirmErrorText(error: unknown): string {
  const missing = requiredFieldsFromError(error);
  return missing.length > 0 ? requiredText(missing) : describeError(error);
}

/** The ticked fields; nothing is ticked at first. */
function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<SuggestionField>>(new Set());
  const toggle = (field: SuggestionField, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });
  return [selected, toggle] as const;
}

/** Extracted text next to per-field suggestions; a field reaches the profile only when ticked. */
export function SuggestionsForm(props: Props) {
  const { upload, profileVersion } = props;
  const suggestions = upload.suggestions ?? null;
  const fields = suggestedFields(suggestions);
  const [selected, toggle] = useSelection();
  const [keepFile, setKeepFile] = useState(upload.keepFile);
  const [hint, setHint] = useState<string | undefined>();
  const { mutation: confirm, conflicted } = useConfirmResume(props);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected.size === 0 && fields.length > 0)
      return setHint(t('profile.resume.nothingSelected'));
    const missing =
      profileVersion === null && suggestions ? missingForNewProfile(suggestions, selected) : [];
    if (missing.length > 0) return setHint(requiredText(missing));
    setHint(undefined);
    confirm.mutate({
      uploadId: upload.id,
      fields: [...selected],
      version: profileVersion,
      keepFile,
    });
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <SuggestionList
        fields={fields}
        suggestions={suggestions}
        selected={selected}
        onToggle={toggle}
      />
      <KeepFileField checked={keepFile} onChange={setKeepFile} />
      {hint ? <Alert tone="error">{hint}</Alert> : null}
      {conflicted ? <Alert tone="warn">{t('profile.resume.conflict')}</Alert> : null}
      {confirm.isError && !conflicted ? (
        <Alert tone="error">{confirmErrorText(confirm.error)}</Alert>
      ) : null}
      <button type="submit" className="button" disabled={confirm.isPending}>
        {confirm.isPending ? t('profile.resume.confirming') : t('profile.resume.confirm')}
      </button>
    </form>
  );
}

interface ListProps {
  fields: SuggestionField[];
  suggestions: ResumeUpload['suggestions'];
  selected: ReadonlySet<SuggestionField>;
  onToggle: (field: SuggestionField, on: boolean) => void;
}

function SuggestionList({ fields, suggestions, selected, onToggle }: ListProps) {
  const roles = useRoles();
  const roleName = (code: string) => roles.data?.find((r) => r.code === code)?.name ?? code;
  return (
    <fieldset className="stack">
      <legend>{t('profile.resume.suggestionsTitle')}</legend>
      <p className="muted">
        {fields.length > 0
          ? t('profile.resume.suggestionsHint')
          : t('profile.resume.suggestionsEmpty')}
      </p>
      {suggestions
        ? fields.map((field) => (
            <label key={field} className="checkbox">
              <input
                type="checkbox"
                checked={selected.has(field)}
                onChange={(event) => onToggle(field, event.target.checked)}
              />
              <span>
                <strong>{t(`profile.resume.field.${field}`)}: </strong>
                {formatSuggestion(field, suggestions, roleName)}
              </span>
            </label>
          ))
        : null}
    </fieldset>
  );
}

function KeepFileField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {t('profile.resume.keepFile')}
        <span className="muted"> {t('profile.resume.keepFileHint')}</span>
      </span>
    </label>
  );
}
