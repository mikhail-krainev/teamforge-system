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
  pickConfirmed,
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

/** `confirmResumeFields` for the ticked fields; on VERSION_CONFLICT it hands over the fresh profile. */
function useConfirmResume({ upload, onConfirmed, onConflict }: Props, keepFile: boolean) {
  const [conflicted, setConflicted] = useState(false);
  const mutation = useIdempotentMutation({
    mutationFn: (input: { fields: SuggestionField[]; version: number | null }, key) =>
      confirmResume(
        {
          uploadId: upload.id,
          fields: pickConfirmed(upload.suggestions ?? {}, new Set(input.fields)),
          keepFile,
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

/** Extracted text next to per-field suggestions; a field reaches the profile only when ticked. */
export function SuggestionsForm(props: Props) {
  const { upload, profileVersion } = props;
  const suggestions = upload.suggestions ?? null;
  const fields = suggestedFields(suggestions);
  const [selected, setSelected] = useState<ReadonlySet<SuggestionField>>(new Set());
  const [keepFile, setKeepFile] = useState(upload.keepFile);
  const [hint, setHint] = useState<string | undefined>();
  const { mutation: confirm, conflicted } = useConfirmResume(props, keepFile);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected.size === 0 && fields.length > 0)
      return setHint(t('profile.resume.nothingSelected'));
    setHint(undefined);
    confirm.mutate({ fields: [...selected], version: profileVersion });
  }
  function toggle(field: SuggestionField, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <ExtractedText text={upload.extractedText} />
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
        <Alert tone="error">{describeError(confirm.error)}</Alert>
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

function ExtractedText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <div className="stack">
      <h3>{t('profile.resume.textTitle')}</h3>
      {/* Resume text is untrusted: it is rendered only as escaped text. */}
      <pre className="pre-text" tabIndex={0}>
        {text}
      </pre>
    </div>
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
