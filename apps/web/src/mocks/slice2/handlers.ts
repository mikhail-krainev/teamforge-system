// Stateful MSW handlers for slice 2, written from docs/api/openapi.yaml. They replace the static
// samples of `generated/handlers.ts` for the operations the web slice uses.
import { http, HttpResponse, type RequestHandler } from 'msw';
import {
  CONSENT_HASH,
  MOCK_USER_ID,
  OTHER_USER_ID,
  ROLES,
  STACK_TAGS,
  sampleProfile,
  type MockDb,
  type Profile,
} from './db';

const API = '*/api';
const RATE_LIMIT_PER_HOUR = 5;
const POLLS_TO_PROCESS = 1;
const POLLS_TO_FINISH = 2;

export function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, code, requestId: 'mock', ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

function omit<T extends object, K extends keyof T>(value: T, keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

const SESSION_COOKIE = 'better-auth.session_token';
const setSession = (value: string, maxAge: number) => ({
  'Set-Cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
});

const unauthenticated = () => problem(401, 'UNAUTHENTICATED');

function authHandlers(db: MockDb): RequestHandler[] {
  return [
    http.post(`${API}/auth/sign-in/magic-link`, async ({ request }) => {
      const body = (await request.json()) as { email?: string };
      if (!body.email?.includes('@')) {
        return problem(400, 'VALIDATION_FAILED', {
          errors: [{ pointer: '/email', message: 'bad' }],
        });
      }
      db.magicLinkRequests += 1;
      if (db.magicLinkRequests > RATE_LIMIT_PER_HOUR) {
        return problem(429, 'RATE_LIMITED', {}, { 'Retry-After': '30' });
      }
      return HttpResponse.json({ status: true });
    }),
    http.post(`${API}/auth/magic-link/confirm`, async ({ request }) => {
      const { token } = (await request.json()) as { token: string };
      if (token.startsWith('expired')) return problem(401, 'EXPIRED_TOKEN');
      if (token.startsWith('used')) return problem(401, 'INVALID_TOKEN');
      db.signedIn = true;
      return HttpResponse.json(
        { redirectTo: '/profile' },
        { headers: setSession('mock', 2_592_000) },
      );
    }),
    http.post(`${API}/auth/sign-in/social`, ({ request }) => {
      db.signedIn = true;
      return HttpResponse.json(
        { url: new URL('/profile', request.url).href, redirect: true },
        { headers: setSession('mock', 2_592_000) },
      );
    }),
    http.post(`${API}/auth/link-social`, ({ request }) => {
      db.githubLinked = true;
      return HttpResponse.json({ url: new URL('/settings', request.url).href, redirect: true });
    }),
    http.get(`${API}/auth/get-session`, () => HttpResponse.json(db.signedIn ? { user: {} } : null)),
    http.post(`${API}/auth/sign-out`, () => {
      db.signedIn = false;
      return HttpResponse.json({ success: true }, { headers: setSession('', 0) });
    }),
  ];
}

function accountHandlers(db: MockDb): RequestHandler[] {
  return [
    http.get(`${API}/v1/me`, () => {
      if (!db.signedIn) return unauthenticated();
      return HttpResponse.json({
        id: MOCK_USER_ID,
        displayName: db.profile?.displayName ?? null,
        emailMasked: 'a***@example.com',
        status: 'active',
        github: { linked: db.githubLinked, login: db.githubLinked ? 'octocat' : null },
        consentRequired: !db.consentAccepted,
        consentVersion: db.consentAccepted ? '2026-01' : null,
        isAdmin: false,
        locale: 'ru',
      });
    }),
    http.get(`${API}/v1/consent/current`, () =>
      HttpResponse.json({
        version: '2026-01',
        textHash: CONSENT_HASH,
        text: 'Я даю согласие на обработку моих персональных данных (черновик текста для разработки).\n\nВключая передачу логина и репозитория в GitHub.',
        publishedAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    http.post(`${API}/v1/me/consents`, () => {
      if (!db.signedIn) return unauthenticated();
      db.consentAccepted = true;
      return HttpResponse.json(
        { version: '2026-01', acceptedAt: new Date().toISOString() },
        { status: 201 },
      );
    }),
    http.get(`${API}/v1/me/github`, () =>
      HttpResponse.json({ linked: db.githubLinked, login: db.githubLinked ? 'octocat' : null }),
    ),
  ];
}

function deletionHandlers(db: MockDb): RequestHandler[] {
  return [
    http.post(`${API}/v1/me/deletion-requests`, () => {
      db.deletionRequested = true;
      const now = Date.now();
      return HttpResponse.json(
        {
          id: MOCK_USER_ID,
          status: 'requested',
          requestedAt: new Date(now).toISOString(),
          scheduledAt: new Date(now + 72 * 3_600_000).toISOString(),
          deadlineAt: new Date(now + 30 * 24 * 3_600_000).toISOString(),
        },
        { status: 202 },
      );
    }),
    http.post(`${API}/v1/deletion-request-cancellations`, async ({ request }) => {
      const { token } = (await request.json()) as { token: string };
      if (token.startsWith('gone')) return problem(410, 'DELETION_CANCEL_GONE');
      db.deletionRequested = false;
      return HttpResponse.json({
        id: MOCK_USER_ID,
        status: 'cancelled',
        requestedAt: '2026-01-01T00:00:00.000Z',
        scheduledAt: '2026-01-04T00:00:00.000Z',
        deadlineAt: '2026-01-31T00:00:00.000Z',
      });
    }),
  ];
}

function profileHandlers(db: MockDb): RequestHandler[] {
  return [
    http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES })),
    http.get(`${API}/v1/catalog/stack-tags`, () =>
      HttpResponse.json({ items: STACK_TAGS, nextCursor: null }),
    ),
    http.get(`${API}/v1/me/profile`, () => {
      if (!db.signedIn) return unauthenticated();
      return db.profile ? HttpResponse.json(db.profile) : problem(404, 'NOT_FOUND');
    }),
    http.put(`${API}/v1/me/profile`, async ({ request }) => {
      if (!db.signedIn) return unauthenticated();
      const input = (await request.json()) as Omit<Profile, 'userId' | 'updatedAt' | 'version'> & {
        version: number | null;
      };
      if ((db.profile?.version ?? null) !== input.version) {
        return problem(409, 'VERSION_CONFLICT', { current: db.profile });
      }
      const fields = omit(input, ['version']);
      db.profile = {
        ...fields,
        userId: MOCK_USER_ID,
        version: (db.profile?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      } as Profile;
      return HttpResponse.json(db.profile);
    }),
    http.get(`${API}/v1/users/:userId/profile`, ({ params }) => {
      if (!db.signedIn) return unauthenticated();
      const profile =
        params.userId === MOCK_USER_ID ? db.profile : sampleProfile({ userId: OTHER_USER_ID });
      if (!profile) return problem(404, 'NOT_FOUND');
      const visible = omit(profile, ['weaknesses', 'version', 'updatedAt']);
      return HttpResponse.json({ ...visible, isDeleted: false });
    }),
  ];
}

const RESUME_TEXT = 'Анна Смирнова\nFrontend-разработчик\nReact, TypeScript';

/** Each poll moves the fake parser along: queued, processing, then done. */
function advanceResume(db: MockDb): void {
  if (!db.resume) return;
  db.resumePolls += 1;
  if (db.resumePolls > POLLS_TO_FINISH) {
    db.resume = {
      ...db.resume,
      status: 'done',
      extractedText: RESUME_TEXT,
      suggestions: {
        displayName: 'Анна Смирнова',
        stack: ['react', 'typescript'],
        rolePrefs: [{ roleCode: 'frontend', level: 'junior' }],
      },
    };
  } else if (db.resumePolls > POLLS_TO_PROCESS) {
    db.resume = { ...db.resume, status: 'processing' };
  }
}

function resumeHandlers(db: MockDb): RequestHandler[] {
  return [
    http.post(`${API}/v1/me/resume`, () => {
      db.resumePolls = 0;
      db.resume = {
        id: '0192f0a0-7c1e-7b3a-8d2f-111111111111',
        status: 'queued',
        keepFile: false,
        createdAt: new Date().toISOString(),
      };
      return HttpResponse.json(db.resume, { status: 202 });
    }),
    http.get(`${API}/v1/me/resume`, () => {
      if (!db.resume) return problem(404, 'NOT_FOUND');
      advanceResume(db);
      return HttpResponse.json(db.resume);
    }),
    http.post(`${API}/v1/me/resume/:uploadId/confirmations`, async ({ request }) => {
      const body = (await request.json()) as {
        confirmedFields: Partial<Profile>;
        profileVersion: number | null;
      };
      if ((db.profile?.version ?? null) !== body.profileVersion) {
        return problem(409, 'VERSION_CONFLICT', { current: db.profile });
      }
      const base =
        db.profile ??
        sampleProfile({
          displayName: 'Новый пользователь',
          stack: [],
          rolePrefs: [],
          experience: [],
        });
      db.profile = { ...base, ...body.confirmedFields, version: (db.profile?.version ?? 0) + 1 };
      db.resume = null;
      return HttpResponse.json(db.profile);
    }),
    http.delete(`${API}/v1/me/resume/:uploadId`, () => {
      if (!db.resume) return problem(404, 'NOT_FOUND');
      db.resume = null;
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

/** All slice 2 handlers over one state object; pass the same `db` to inspect or seed it. */
export function slice2Handlers(db: MockDb): RequestHandler[] {
  return [
    ...authHandlers(db),
    ...accountHandlers(db),
    ...deletionHandlers(db),
    ...profileHandlers(db),
    ...resumeHandlers(db),
  ];
}
