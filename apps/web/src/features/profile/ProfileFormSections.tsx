'use client';

import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { CatalogEntry } from './api';
import { ExperienceEditor } from './ExperienceEditor';
import { LIMITS, type DraftErrors, type ProfileDraft } from './model';
import { RolePrefsEditor } from './RolePrefsEditor';
import { StackPicker } from './StackPicker';
import { TimezoneSelect } from './TimezoneSelect';

export interface SectionProps {
  draft: ProfileDraft;
  patch: (change: Partial<ProfileDraft>) => void;
  fieldError: (name: string) => string | undefined;
}

export function BasicsFieldset(props: SectionProps) {
  const { draft, patch, fieldError } = props;
  return (
    <fieldset className="stack">
      <legend>{t('profile.form.legendBasics')}</legend>
      <Field
        id="profile-name"
        label={t('profile.form.name')}
        hint={t('profile.form.nameHint')}
        error={fieldError('displayName')}
        required
      >
        {(c) => (
          <input
            {...c}
            type="text"
            autoComplete="name"
            maxLength={LIMITS.nameMax}
            value={draft.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
          />
        )}
      </Field>
      <ScheduleFields {...props} />
      <Field
        id="profile-portfolio"
        label={t('profile.form.portfolio')}
        hint={t('profile.form.portfolioHint')}
        error={fieldError('portfolioUrl')}
      >
        {(c) => (
          <input
            {...c}
            type="url"
            autoComplete="url"
            value={draft.portfolioUrl}
            onChange={(e) => patch({ portfolioUrl: e.target.value })}
          />
        )}
      </Field>
    </fieldset>
  );
}

function ScheduleFields({ draft, patch, fieldError }: SectionProps) {
  return (
    <div className="grid-2">
      <Field
        id="profile-timezone"
        label={t('profile.form.timezone')}
        error={fieldError('timezone')}
        required
      >
        {(c) => (
          <TimezoneSelect
            {...c}
            value={draft.timezone}
            onChange={(timezone) => patch({ timezone })}
          />
        )}
      </Field>
      <Field
        id="profile-hours"
        label={t('profile.form.hours')}
        hint={t('profile.form.hoursHint')}
        error={fieldError('hoursPerWeek')}
        required
      >
        {(c) => (
          <input
            {...c}
            type="number"
            inputMode="numeric"
            min={LIMITS.hoursMin}
            max={LIMITS.hoursMax}
            value={draft.hoursPerWeek}
            onChange={(e) => patch({ hoursPerWeek: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

export function LinesFieldset({ draft, patch, fieldError }: SectionProps) {
  return (
    <div className="stack">
      <Field
        id="profile-strengths"
        label={t('profile.form.strengths')}
        hint={t('profile.form.linesHint')}
        error={fieldError('strengths')}
      >
        {(c) => (
          <textarea
            {...c}
            value={draft.strengths}
            onChange={(e) => patch({ strengths: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="profile-weaknesses"
        label={t('profile.form.weaknesses')}
        error={fieldError('weaknesses')}
      >
        {(c) => (
          <textarea
            {...c}
            value={draft.weaknesses}
            onChange={(e) => patch({ weaknesses: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

interface FieldsProps extends SectionProps {
  errors: DraftErrors;
  roles: readonly CatalogEntry[];
  tags: readonly CatalogEntry[];
}

/** All editable sections of the profile form, in display order. */
export function ProfileFields({ draft, patch, errors, fieldError, roles, tags }: FieldsProps) {
  return (
    <>
      <BasicsFieldset draft={draft} patch={patch} fieldError={fieldError} />
      <RolePrefsEditor
        value={draft.rolePrefs}
        roles={roles}
        error={fieldError('rolePrefs')}
        onChange={(rolePrefs) => patch({ rolePrefs })}
      />
      <StackPicker
        value={draft.stack}
        tags={tags}
        error={fieldError('stack')}
        onChange={(stack) => patch({ stack })}
      />
      <ExperienceEditor
        value={draft.experience}
        errors={errors}
        onChange={(experience) => patch({ experience })}
      />
      <LinesFieldset draft={draft} patch={patch} fieldError={fieldError} />
    </>
  );
}
