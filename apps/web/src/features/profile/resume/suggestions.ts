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
