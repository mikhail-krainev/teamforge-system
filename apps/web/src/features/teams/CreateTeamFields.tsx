'use client';

import { Field } from '@/components/ui/Field';
import { TimezoneSelect } from '@/features/profile/TimezoneSelect';
import { t } from '@/i18n';
import type { ProductType } from './api';
import { LIMITS, type TeamDraft } from './model';

interface Props {
  draft: TeamDraft;
  patch: (change: Partial<TeamDraft>) => void;
  fieldError: (id: string) => string | undefined;
  productTypes: readonly ProductType[];
}

function NameAndDescription({ draft, patch, fieldError }: Omit<Props, 'productTypes'>) {
  return (
    <>
      <Field
        id="name"
        label={t('teams.create.name')}
        hint={t('teams.create.nameHint')}
        error={fieldError('name')}
        required
      >
        {(c) => (
          <input
            {...c}
            type="text"
            maxLength={LIMITS.nameMax}
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="description"
        label={t('teams.create.description')}
        error={fieldError('description')}
      >
        {(c) => (
          <textarea
            {...c}
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        )}
      </Field>
    </>
  );
}

function ProductType({ draft, patch, fieldError, productTypes }: Props) {
  return (
    <>
      <Field
        id="productTypeCode"
        label={t('teams.create.productType')}
        error={fieldError('productTypeCode')}
        required
      >
        {(c) => (
          <select
            {...c}
            value={draft.productTypeCode}
            onChange={(e) => patch({ productTypeCode: e.target.value })}
          >
            <option value="">{t('teams.create.productTypePick')}</option>
            {productTypes
              .filter((type) => type.active)
              .map((type) => (
                <option key={type.code} value={type.code}>
                  {type.name}
                </option>
              ))}
          </select>
        )}
      </Field>
    </>
  );
}

function Schedule({ draft, patch, fieldError }: Omit<Props, 'productTypes'>) {
  return (
    <div className="grid-2">
      <Field
        id="timezone"
        label={t('teams.create.timezone')}
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
        id="hoursPerWeek"
        label={t('teams.create.hours')}
        hint={t('teams.create.hoursHint')}
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

export function CreateTeamFields(props: Props) {
  return (
    <>
      <NameAndDescription {...props} />
      <ProductType {...props} />
      <Schedule {...props} />
    </>
  );
}
