import type { GithubIdentity } from '../../../../test/fakes/github-server.js';
import type { BrowserSession } from '../../../../test/fixtures/clients.js';
import type { World } from '../../../../test/fixtures/world.js';
import type { InjectResponse } from '../../../../test/helpers/http.js';

export type GithubFlowKind = 'sign-in' | 'link';

const PATHS: Record<GithubFlowKind, string> = {
  'sign-in': '/auth/sign-in/social',
  link: '/auth/link-social',
};

/** Step 1 of the OAuth dance: the application hands out the GitHub authorize URL. */
export async function beginGithub(
  session: BrowserSession,
  kind: GithubFlowKind,
  callbackURL = '/profile',
  ip?: string,
): Promise<{ response: InjectResponse; authorizeUrl: string }> {
  const response = await session.post(
    PATHS[kind],
    { provider: 'github', callbackURL },
    { idempotencyKey: null, ...(ip ? { ip } : {}) },
  );
  const authorizeUrl = response.statusCode === 200 ? response.json<{ url: string }>().url : '';
  return { response, authorizeUrl };
}

/**
 * Steps 2-3: the user clicks "Authorize" at GitHub (the double issues a code for `identity`) and the
 * browser returns to the application's callback. The response is the callback's own answer.
 */
export function finishGithub(
  world: World,
  session: BrowserSession,
  authorizeUrl: string,
  identity: GithubIdentity,
  tamper?: (callback: URL) => void,
): Promise<InjectResponse> {
  const github = world.github;
  if (!github) throw new Error('World.start({ github: true }) is required');
  const callback = new URL(github.approve(authorizeUrl, identity));
  tamper?.(callback);
  return session.get(`${callback.pathname.replace(/^\/api/, '')}${callback.search}`);
}

export type CallbackOutcome = 'ok' | 'already-linked' | 'error';

/**
 * Classifies the callback answer. A browser flow ends in a redirect: to the callback URL when it
 * worked, to an error page when it did not; the "GitHub already linked" conflict (409
 * GITHUB_ALREADY_LINKED) may be delivered either as a 409 problem or as an error redirect naming it.
 */
export function callbackOutcome(response: InjectResponse): CallbackOutcome {
  const location = String(response.headers.location ?? '');
  const haystack = `${response.body}\n${location}`;
  if (response.statusCode === 409 || /GITHUB_ALREADY_LINKED/i.test(haystack))
    return 'already-linked';
  const redirected = response.statusCode >= 300 && response.statusCode < 400;
  if (redirected && !/error/i.test(location)) return 'ok';
  return 'error';
}

/** Full sign-in with GitHub as a browser; returns the session and the callback answer. */
export async function signInWithGithub(
  world: World,
  identity: GithubIdentity,
  callbackURL = '/profile',
): Promise<{ session: BrowserSession; callback: InjectResponse }> {
  const session = world.browser();
  const { authorizeUrl } = await beginGithub(session, 'sign-in', callbackURL);
  const callback = await finishGithub(world, session, authorizeUrl, identity);
  return { session, callback };
}
