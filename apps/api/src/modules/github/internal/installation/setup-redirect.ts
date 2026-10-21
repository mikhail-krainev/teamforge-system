/**
 * Where the browser goes after the setup callback (contract of `githubSetupCallback`). The error is a
 * short code in `[a-z_]` that the web shows in Russian; it never carries a message of GitHub.
 */
export type SetupError =
  | 'code_missing'
  | 'state_invalid'
  | 'installation_not_found'
  | 'installation_suspended'
  | 'permissions_missing'
  | 'not_lead'
  | 'account_mismatch'
  | 'github_unavailable';

export type SetupOutcome =
  | { ok: true; teamId: string; installationId: number }
  | { ok: false; error: SetupError; teamId?: string };

/** The permissions of the App that FR-GH-01 and 7.1 need: Metadata, Issues, Pull requests, Actions (read). */
export const REQUIRED_PERMISSIONS = ['metadata', 'issues', 'pull_requests', 'actions'] as const;

export function redirectTarget(appOrigin: string, outcome: SetupOutcome): string {
  if (outcome.ok) {
    const url = new URL(`/teams/${outcome.teamId}/settings/repository`, appOrigin);
    url.searchParams.set('installation', String(outcome.installationId));
    return url.toString();
  }
  // Without a team (an unknown state) the web explains the failure on its own page.
  const path =
    outcome.teamId === undefined ? '/github/setup' : `/teams/${outcome.teamId}/settings/repository`;
  const url = new URL(path, appOrigin);
  url.searchParams.set('error', outcome.error);
  return url.toString();
}
