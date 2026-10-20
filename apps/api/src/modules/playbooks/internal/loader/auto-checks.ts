/**
 * Catalog of automatic checks (docs/playbooks.md 2.4, FR-PLAY-08). A key in `auto_checks` is the name,
 * optionally followed by `:N` for the checks that take a number (`min_files:5`, `pr_cross_review:3`).
 */
export const PLAIN_AUTO_CHECKS = [
  'file_ok',
  'sha_dedup',
  'link_https',
  'repo_exists',
  'repo_final',
  'release_alive_web',
  'release_alive_ml',
  'ritual_fields',
  'md_headings',
  'ci_workflow',
] as const;

/** Checks with a numeric parameter after the colon. */
export const PARAMETRIC_AUTO_CHECKS = ['min_files', 'pr_cross_review'] as const;

/** The checks that prove a working release (rule 4 of docs/playbooks.md 2.3). */
export const RELEASE_AUTO_CHECKS: readonly string[] = ['release_alive_web', 'release_alive_ml'];
export const REPO_FINAL_CHECK = 'repo_final';

const MAX_PARAMETER = 100;

export type AutoCheckProblem =
  'unknown' | 'parameter_missing' | 'parameter_invalid' | 'parameter_unexpected';

/** `null` when the key is in the catalog and well-formed, otherwise why it is not. */
export function checkAutoCheckKey(key: string): AutoCheckProblem | null {
  const colon = key.indexOf(':');
  const name = colon === -1 ? key : key.slice(0, colon);
  const parameter = colon === -1 ? undefined : key.slice(colon + 1);
  if ((PARAMETRIC_AUTO_CHECKS as readonly string[]).includes(name)) {
    if (parameter === undefined) return 'parameter_missing';
    return /^[1-9][0-9]{0,2}$/.test(parameter) && Number(parameter) <= MAX_PARAMETER
      ? null
      : 'parameter_invalid';
  }
  if ((PLAIN_AUTO_CHECKS as readonly string[]).includes(name)) {
    return parameter === undefined ? null : 'parameter_unexpected';
  }
  return 'unknown';
}

/** Name of the check without the parameter. */
export function autoCheckName(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}
