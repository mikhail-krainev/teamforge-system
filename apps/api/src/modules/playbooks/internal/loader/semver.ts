export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * `MAJOR.MINOR.PATCH` without leading zeros, pre-release or build parts. A part has at most 10 digits
 * (the width of the largest `integer`, 2147483647); `parseSemver` then refuses what does not fit.
 */
const SEMVER = /^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})$/;

export function parseSemver(value: string): SemVer | null {
  const match = SEMVER.exec(value);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  const parsed = { major: Number(major), minor: Number(minor), patch: Number(patch) };
  const limit = 2_147_483_647;
  return parsed.major > limit || parsed.minor > limit || parsed.patch > limit ? null : parsed;
}

/** Negative, zero or positive like a comparator. */
export function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
