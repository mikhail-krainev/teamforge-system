export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** `MAJOR.MINOR.PATCH` without leading zeros, pre-release or build parts; each part fits `integer`. */
const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

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
