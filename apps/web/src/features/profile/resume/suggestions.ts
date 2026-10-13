import { ApiError } from '@/lib/api/errors';
import type { ProfileFields } from '../model';
import { levelLabel } from '../model';

export const SUGGESTION_FIELDS = [
  'displayName',
  'timezone',
  'hoursPerWeek',
  'portfolioUrl',
  'rolePrefs',
  'stack',
  'experience',
  'strengths',
  'weaknesses',
] as const;

export type SuggestionField = (typeof SUGGESTION_FIELDS)[number];

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value !== '';
}

/** Fields for which the parser proposed a value, in display order. */
export function suggestedFields(suggestions: ProfileFields | null | undefined): SuggestionField[] {
  if (!suggestions) return [];
  return SUGGESTION_FIELDS.filter((field) => hasValue(suggestions[field]));
}

/** Plain-text preview of one suggested value (rendered escaped by React). */
export function formatSuggestion(
  field: SuggestionField,
  suggestions: ProfileFields,
  roleName: (code: string) => string,
): string {
  switch (field) {
    case 'rolePrefs':
      return (suggestions.rolePrefs ?? [])
        .map((r) => `${roleName(r.roleCode)} (${levelLabel(r.level)})`)
        .join(', ');
    case 'stack':
      return (suggestions.stack ?? []).join(', ');
    case 'experience':
      return (suggestions.experience ?? []).map((e) => e.title).join('; ');
    case 'strengths':
      return (suggestions.strengths ?? []).join('; ');
    case 'weaknesses':
      return (suggestions.weaknesses ?? []).join('; ');
    default:
      return String(suggestions[field] ?? '');
  }
}

/** Only the ticked fields leave the browser (FR-PROF-04). */
export function pickConfirmed(
  suggestions: ProfileFields,
  selected: ReadonlySet<SuggestionField>,
): ProfileFields {
  const picked: Record<string, unknown> = {};
  for (const field of SUGGESTION_FIELDS) {
    if (selected.has(field) && hasValue(suggestions[field])) picked[field] = suggestions[field];
  }
  return picked as ProfileFields;
}

/** What the API needs in `confirmedFields` when the user has no profile yet (S2CR-10). */
export const NEW_PROFILE_REQUIRED: readonly SuggestionField[] = [
  'displayName',
  'timezone',
  'hoursPerWeek',
  'stack',
  'rolePrefs',
  'experience',
  'strengths',
  'weaknesses',
];

/**
 * Required fields a confirmation for a new profile would still lack: not ticked, or ticked but
 * empty in the suggestions (an empty value is not sent at all).
 */
export function missingForNewProfile(
  suggestions: ProfileFields,
  selected: ReadonlySet<SuggestionField>,
): SuggestionField[] {
  const sent = pickConfirmed(suggestions, selected);
  return NEW_PROFILE_REQUIRED.filter((field) => !(field in sent));
}

/** Fields named by a 422 `required_for_new_profile` problem (`/confirmedFields/<name>`). */
export function requiredFieldsFromError(error: unknown): SuggestionField[] {
  if (!(error instanceof ApiError) || error.status !== 422) return [];
  const names = new Set<string>();
  for (const item of error.problem?.errors ?? []) {
    if (item.code !== 'required_for_new_profile') continue;
    const name = item.pointer.split('/').filter(Boolean).pop();
    if (name) names.add(name);
  }
  return SUGGESTION_FIELDS.filter((field) => names.has(field));
}
