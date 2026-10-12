import type { FieldError } from '../../../../platform/errors/domain-error.js';
import type { ProfileInput } from './profile.types.js';

/** What the database knows: catalog codes with their `active` flag, and what the profile already holds. */
export interface CatalogState {
  roles: Map<string, boolean>;
  stack: Map<string, boolean>;
  heldRoles: Set<string>;
  heldStack: Set<string>;
}

const invalid = (pointer: string, code: string, message: string): FieldError => ({
  pointer,
  code,
  message,
});

export function isIanaTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A code can be chosen when it exists and is active, or when the profile already holds it (FR-PROF-09). */
function choosable(
  code: string,
  known: Map<string, boolean>,
  held: Set<string>,
): 'ok' | 'unknown' | 'inactive' {
  const active = known.get(code);
  if (active === undefined) return 'unknown';
  return active || held.has(code) ? 'ok' : 'inactive';
}

function stackErrors(input: ProfileInput, state: CatalogState): FieldError[] {
  return input.stack.flatMap((code, index) => {
    const verdict = choosable(code, state.stack, state.heldStack);
    return verdict === 'ok'
      ? []
      : [invalid(`/stack/${index}`, `${verdict}_stack_tag`, `Stack tag is ${verdict}`)];
  });
}

function roleErrors(input: ProfileInput, state: CatalogState): FieldError[] {
  const seen = new Set<string>();
  return input.rolePrefs.flatMap((pref, index) => {
    const pointer = `/rolePrefs/${index}`;
    if (seen.has(pref.roleCode)) {
      return [invalid(pointer, 'duplicate_role', 'A role can appear once')];
    }
    seen.add(pref.roleCode);
    const verdict = choosable(pref.roleCode, state.roles, state.heldRoles);
    return verdict === 'ok' ? [] : [invalid(pointer, `${verdict}_role`, `Role is ${verdict}`)];
  });
}

function experienceErrors(input: ProfileInput): FieldError[] {
  return input.experience.flatMap((entry, index) =>
    entry.to != null && entry.to < entry.from
      ? [invalid(`/experience/${index}`, 'period_reversed', 'The period ends before it starts')]
      : [],
  );
}

/** Domain rules of `saveMyProfile` that the schema cannot express (422, architecture 13.3). */
export function profileErrors(input: ProfileInput, state: CatalogState): FieldError[] {
  const errors = [...stackErrors(input, state), ...roleErrors(input, state)];
  if (!isIanaTimezone(input.timezone)) {
    errors.push(invalid('/timezone', 'unknown_timezone', 'Not an IANA time zone'));
  }
  return [...errors, ...experienceErrors(input)];
}
