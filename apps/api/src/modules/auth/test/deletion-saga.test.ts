import { afterAll, beforeAll, expect, it } from 'vitest';
import { githubIdentity } from '../../../../test/fakes/github-server.js';
import { countOf } from '../../../../test/fixtures/assertions.js';
import {
  PROFILE_ROLES,
  PROFILE_STACK,
  profileInput,
  resumeFile,
  RESUME_TEXT,
  ResumeBucket,
} from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { cancelTokenOf } from './deletion-helpers.js';
import { beginGithub, finishGithub } from './github-flow.js';

const HOUR = 3_600_000;
const SCHEMAS = [
  'auth',
  'profiles',
  'platform',
  'workspace',
  'teams',
  'matching',
  'github',
  'rewards',
];

describeInfra(
  'S2 auth: the deletion saga with a fake clock (FR-AUTH-09)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    const bucket = new ResumeBucket();

    beforeAll(async () => {
      world = await World.start({ clock, github: true, resumeWorker: true });
      await world.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
    });

    afterAll(async () => {
      if (!world) return;
      bucket.destroy();
      await world.close();
    });

    const status = async (userId: string): Promise<string | undefined> =>
      (
        await world.sql<{ status: string }[]>`SELECT status FROM auth."user" WHERE id = ${userId}`
      )[0]?.status;

    /** Rows of every table of the application schemas whose text form contains the needle. */
    async function rowsContaining(needle: string): Promise<string[]> {
      const tables = await world.sql<{ table_schema: string; table_name: string }[]>`
        SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND table_schema = ANY(${SCHEMAS})`;
      const hits: string[] = [];
      for (const { table_schema, table_name } of tables) {
        const found = await world.sql.unsafe(
          `SELECT count(*)::int AS n FROM "${table_schema}"."${table_name}" t WHERE t::text ILIKE $1`,
          [`%${needle}%`],
        );
        if (Number(found[0]?.n) > 0) hits.push(`${table_schema}.${table_name}`);
      }
      return hits;
    }

    it('FR-AUTH-09: before 72 hours the request waits and can be cancelled; the scheduler does not start the saga early', async () => {
      const { user, session } = await world.signedIn('saga-early');
      const before = await world.mail.countTo(user.email);
      expect(
        (await session.post('/v1/me/deletion-requests', { reason: 'user_request', confirm: true }))
          .statusCode,
      ).toBe(202);
      const token = cancelTokenOf(await world.mail.latestTo(user.email, { minCount: before + 1 }));

      clock.advance(71 * HOUR + 59 * 60_000);
      await world.runMaintenance('deletion-scheduler');
      const rows = await world.sql<{ status: string }[]>`
        SELECT status FROM auth.deletion_request WHERE user_id = ${user.id}`;
      expect(rows[0]?.status).toBe('requested');
      expect(await status(user.id)).toBe('deleting');

      const cancelled = await world
        .anonymous()
        .post('/v1/deletion-request-cancellations', { token }, { idempotencyKey: null });
      expect(cancelled.statusCode).toBe(200);
      expect(await status(user.id)).toBe('active');
    });

    it('FR-AUTH-09: after 72 hours the saga erases the personal data and a new sign-in creates a NEW user', async () => {
      const { user, session } = await world.signedIn('saga-full');
      const identity = githubIdentity(`saga-${world.runId}`);
      const link = await beginGithub(session, 'link');
      await finishGithub(world, session, link.authorizeUrl, identity);
      expect((await session.put('/v1/me/profile', profileInput())).statusCode).toBe(200);
      const upload = await session.upload('/v1/me/resume', resumeFile('resume.pdf'));
      expect(upload.statusCode).toBe(202);
      const stored = await world.sql<{ storage_key: string }[]>`
        SELECT storage_key FROM profiles.resume_upload WHERE user_id = ${user.id}`;
      const storageKey = stored[0]?.storage_key ?? '';
      expect(storageKey).not.toBe('');
      expect(await bucket.exists(storageKey)).toBe(true);

      const requestResponse = await session.post('/v1/me/deletion-requests', {
        reason: 'user_request',
        confirm: true,
      });
      expect(requestResponse.statusCode).toBe(202);

      clock.advance(72 * HOUR + 60_000);
      await world.runMaintenance('deletion-scheduler');
      await waitFor(async () => {
        const rows = await world.sql<{ status: string }[]>`
          SELECT status FROM auth.deletion_request WHERE user_id = ${user.id}`;
        return rows[0]?.status === 'completed';
      }, 30_000);

      const row = (
        await world.sql<
          {
            email: string | null;
            email_normalized: string | null;
            name: string | null;
            github_user_id: string | null;
            github_login: string | null;
            status: string;
          }[]
        >`SELECT email, email_normalized, name, github_user_id::text, github_login, status
            FROM auth."user" WHERE id = ${user.id}`
      )[0];
      expect(row).toEqual({
        email: null,
        email_normalized: null,
        name: null,
        github_user_id: null,
        github_login: null,
        status: 'deleted',
      });

      for (const table of [
        'profile',
        'profile_role_pref',
        'profile_stack',
        'profile_experience',
        'resume_upload',
      ]) {
        expect(
          await countOf(world.sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM ${world.sql(`profiles.${table}`)} WHERE user_id = ${user.id}`),
          `profiles.${table}`,
        ).toBe(0);
      }
      expect(await bucket.exists(storageKey), 'resume object in S3').toBe(false);
      expect(
        await countOf(
          world.sql<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM auth.account WHERE user_id = ${user.id}`,
        ),
      ).toBe(0);
      expect(
        await countOf(
          world.sql<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM auth.identity_signal WHERE user_id = ${user.id}`,
        ),
      ).toBe(0);
      expect(
        await countOf(
          world.sql<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM platform.idempotency_key WHERE user_id = ${user.id}`,
        ),
      ).toBe(0);

      const tombstones = await world.sql<{ kind: string }[]>`
        SELECT kind FROM auth.identity_tombstone ORDER BY kind`;
      expect(tombstones.map((t) => t.kind)).toEqual(
        expect.arrayContaining(['email_normalized', 'github_user_id']),
      );
      const consent = await world.sql<{ ip_hash: Buffer | null }[]>`
        SELECT ip_hash FROM auth.consent WHERE user_id = ${user.id}`;
      expect(consent.length).toBeGreaterThanOrEqual(1);
      expect(consent.every((c) => c.ip_hash === null)).toBe(true);
      expect(
        await countOf(world.sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM auth.deletion_log WHERE request_id IN
          (SELECT id FROM auth.deletion_request WHERE user_id = ${user.id})`),
      ).toBeGreaterThanOrEqual(1);

      // SQL sweep over every application schema: no e-mail, GitHub login or resume text is left
      for (const needle of [user.email, identity.login, RESUME_TEXT]) {
        expect(await rowsContaining(needle), `rows containing "${needle}"`).toEqual([]);
      }

      // the same address starts over as a new person
      const again = await world.signIn(user.email);
      const fresh = await again.get('/v1/me');
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json<{ id: string }>().id).not.toBe(user.id);
    });

    it('FR-AUTH-09: once the saga has started the cancel link is gone (410 DELETION_CANCEL_GONE)', async () => {
      const { user, session } = await world.signedIn('saga-late-cancel');
      const before = await world.mail.countTo(user.email);
      await session.post('/v1/me/deletion-requests', { reason: 'user_request', confirm: true });
      const token = cancelTokenOf(await world.mail.latestTo(user.email, { minCount: before + 1 }));
      clock.advance(73 * HOUR);
      await world.runMaintenance('deletion-scheduler');
      await waitFor(async () => (await status(user.id)) === 'deleted', 30_000);
      const response = await world
        .anonymous()
        .post('/v1/deletion-request-cancellations', { token }, { idempotencyKey: null });
      expect(response.statusCode).toBe(410);
      expect(response.json<{ code: string }>().code).toBe('DELETION_CANCEL_GONE');
    });

    it('FR-AUTH-09: the scheduler is idempotent: a second run changes nothing and starts no second saga', async () => {
      const { user, session } = await world.signedIn('saga-twice');
      await session.post('/v1/me/deletion-requests', { reason: 'user_request', confirm: true });
      clock.advance(73 * HOUR);
      await world.runMaintenance('deletion-scheduler');
      await waitFor(async () => (await status(user.id)) === 'deleted', 30_000);
      const logsBefore = await countOf(
        world.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.deletion_log`,
      );
      await world.runMaintenance('deletion-scheduler');
      const logsAfter = await countOf(
        world.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.deletion_log`,
      );
      expect(logsAfter).toBe(logsBefore);
    });
  },
);
