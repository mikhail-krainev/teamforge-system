import { ApiError } from '@/lib/api/errors';
import type { Profile } from './model';

function isProfile(value: unknown): value is Profile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'number' &&
    typeof v.displayName === 'string' &&
    Array.isArray(v.stack) &&
    Array.isArray(v.rolePrefs)
  );
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT';
}

/**
 * The server-side profile carried by a 409 VERSION_CONFLICT (`problem.current`), or `null` when
 * the error is something else or the body has no usable `current` (the caller then refetches).
 */
export function currentFromConflict(error: unknown): Profile | null {
  if (!isVersionConflict(error)) return null;
  const current = (error as ApiError).problem?.current;
  return isProfile(current) ? current : null;
}
