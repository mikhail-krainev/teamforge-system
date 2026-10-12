import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type postgres from 'postgres';
import {
  githubEnv,
  type GithubIdentity,
  type GithubServer,
  startGithubServer,
} from '../fakes/github-server.js';
import { startFakeResumeWorker, type FakeResumeWorker } from '../fakes/resume-worker.js';
import { SmtpSink } from '../fakes/smtp-sink.js';
import { tokenLinkOf } from '../fakes/mail.js';
import { createTestApp, createTestWorker, type TestApp } from '../helpers/app.js';
import type { FakeClock } from '../helpers/clock.js';
import {
  createTestDatabase,
  type TestDatabase,
  uniqueQueuePrefix,
  waitFor,
} from '../helpers/infra.js';
import { anonymousCaller, BrowserSession, callerFor, type Caller, randomIp } from './clients.js';
import { type UserFixture, user as userFixture } from './index.js';

export interface WorldOptions {
  /** Shared by the API and the worker (deadlines of the deletion saga, sliding windows). */
  clock?: FakeClock;
  /** Start the GitHub double and point the application at it. */
  github?: boolean;
  /** Start a worker process (mail, events, resume dispatch, maintenance). Default: true. */
  worker?: boolean;
  /** Consume `resume-parse` in-process instead of the resume-worker container. */
  resumeWorker?: boolean;
  /** https origins, so that `Secure` session cookies are expected (FR-AUTH-01). */
  secureOrigins?: boolean;
  env?: Record<string, string | undefined>;
}

export interface TestUserOptions {
  email?: string;
  /** Consent of the current text (default true); `'outdated'` records an older version only. */
  consent?: boolean | 'outdated';
  admin?: boolean;
  github?: GithubIdentity;
  status?: 'active' | 'deleting' | 'deleted';
}

/**
 * Everything one slice 2 test file needs: a database cloned from the template, the HTTP application,
 * a worker, an SMTP sink, optionally the GitHub double and a stand-in for the resume parser.
 * Tests reach the application only over HTTP, SQL and the fakes - never through module internals.
 */
export class World {
  readonly runId = randomBytes(4).toString('hex');
  private consent: { version: string; textHash: string } | undefined;
  private maintenanceRuns = 0;

  private constructor(
    readonly db: TestDatabase,
    readonly testApp: TestApp,
    readonly mail: SmtpSink,
    readonly queuePrefix: string,
    readonly options: WorldOptions,
    readonly github: GithubServer | undefined,
    readonly resume: FakeResumeWorker | undefined,
    private readonly workerContext: INestApplicationContext | undefined,
    private readonly extraApps: TestApp[],
  ) {}

  static async start(options: WorldOptions = {}): Promise<World> {
    const db = await createTestDatabase();
    const mail = await SmtpSink.start();
    const queuePrefix = uniqueQueuePrefix();
    const github = options.github ? await startGithubServer() : undefined;
    const env: Record<string, string | undefined> = {
      DATABASE_POOL_MAX: '30',
      SMTP_URL: mail.smtpUrl,
      ...(process.env.S3_TEST_ENDPOINT
        ? {
            S3_ENDPOINT: process.env.S3_TEST_ENDPOINT,
            S3_ACCESS_KEY: process.env.S3_TEST_ACCESS_KEY,
            S3_SECRET_KEY: process.env.S3_TEST_SECRET_KEY,
          }
        : {}),
      ...(process.env.REDIS_RESUME_URL ? { REDIS_RESUME_URL: process.env.REDIS_RESUME_URL } : {}),
      ...(github ? githubEnv(github) : {}),
      ...(options.secureOrigins
        ? { BETTER_AUTH_URL: 'https://api.teamforge.test', APP_ORIGIN: 'https://teamforge.test' }
        : {}),
      ...options.env,
    };
    const common = {
      databaseUrl: db.url,
      queuePrefix,
      env,
      ...(options.clock ? { clock: options.clock } : {}),
    };
    const testApp = await createTestApp(common);
    const worker = options.worker === false ? undefined : await createTestWorker(common);
    const resume = options.resumeWorker ? startFakeResumeWorker(queuePrefix) : undefined;
    return new World(db, testApp, mail, queuePrefix, options, github, resume, worker?.context, []);
  }

  get app(): NestFastifyApplication {
    return this.testApp.app;
  }

  get sql(): postgres.Sql {
    return this.db.sql;
  }

  /** Application log lines so far (pino JSON). */
  get logs(): string[] {
    return this.testApp.logs;
  }

  get origin(): string {
    return this.testApp.config.APP_ORIGIN;
  }

  /** A second application instance on the same database and Redis (no process-local state, FR-AUTH-07). */
  async startSecondApp(): Promise<NestFastifyApplication> {
    const second = await createTestApp({
      databaseUrl: this.db.url,
      queuePrefix: this.queuePrefix,
      env: { DATABASE_POOL_MAX: '10', SMTP_URL: this.mail.smtpUrl, ...this.options.env },
    });
    this.extraApps.push(second);
    return second.app;
  }

  /** A user acting through `X-Test-User` (no cookie); the row must exist (`createUser`). */
  as(user: UserFixture | string): Caller {
    return callerFor(this.app, typeof user === 'string' ? user : user.id, this.origin);
  }

  anonymous(): Caller {
    return anonymousCaller(this.app, this.origin);
  }

  browser(app: NestFastifyApplication = this.app): BrowserSession {
    return new BrowserSession(app, this.origin);
  }

  /** Unique address for this run (rate-limit keys and unique indexes survive between runs). */
  email(label: string, domain = 'example.test'): string {
    return `${label}-${this.runId}@${domain}`;
  }

  /** Current consent text as the API publishes it (version and SHA-256 of the text). */
  async currentConsent(): Promise<{ version: string; textHash: string }> {
    if (this.consent) return this.consent;
    const response = await this.anonymous().get('/v1/consent/current');
    if (response.statusCode !== 200) {
      throw new Error(`GET /v1/consent/current -> HTTP ${response.statusCode}: ${response.body}`);
    }
    const body = response.json<{ version: string; textHash: string }>();
    this.consent = { version: body.version, textHash: body.textHash };
    return this.consent;
  }

  async grantConsent(userId: string, which: boolean | 'outdated' = true): Promise<void> {
    if (which === false) return;
    const current = which === 'outdated' ? undefined : await this.currentConsent();
    const hash = current?.textHash ?? createHash('sha256').update('outdated text').digest('hex');
    await this.sql`
      INSERT INTO auth.consent (id, user_id, version, text_hash, accepted_at)
      VALUES (${randomUUID()}, ${userId}, ${current?.version ?? 'outdated-0'}, decode(${hash}, 'hex'), now())`;
  }

  /** Inserts a user row directly (fixtures never go through HTTP) and, by default, records consent. */
  async createUser(label: string, options: TestUserOptions = {}): Promise<UserFixture> {
    const email = options.email ?? this.email(label);
    const fixture = userFixture(`${label}-${this.runId}`, { email, displayName: label });
    const github = options.github;
    await this.sql`
      INSERT INTO auth."user" (id, name, email, email_verified, email_normalized, github_user_id,
                               github_login, status, is_admin, locale, created_at, updated_at)
      VALUES (${fixture.id}, ${label}, ${email}, true, ${email.toLowerCase()}, ${github?.id ?? null},
              ${github?.login ?? null}, ${options.status ?? 'active'}, ${options.admin ?? false},
              'ru', now(), now())`;
    await this.grantConsent(fixture.id, options.consent ?? true);
    return fixture;
  }

  /** The id Better Auth gave the user it created at first sign-in. */
  async userIdByEmail(email: string): Promise<string> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM auth."user" WHERE email = ${email} OR email_normalized = ${email.toLowerCase()}`;
    const id = rows[0]?.id;
    if (!id) throw new Error(`no auth.user for ${email}`);
    return id;
  }

  /** Full magic-link sign-in as a browser: request, read the mail, confirm. Returns the cookie session. */
  async signIn(email: string, ip: string = randomIp()): Promise<BrowserSession> {
    const session = this.browser();
    const before = await this.mail.countTo(email);
    const request = await session.post(
      '/auth/sign-in/magic-link',
      { email },
      { idempotencyKey: null, ip },
    );
    if (request.statusCode !== 200) {
      throw new Error(`sign-in/magic-link -> HTTP ${request.statusCode}: ${request.body}`);
    }
    const message = await this.mail.latestTo(email, { minCount: before + 1 });
    const { token } = tokenLinkOf(message);
    const confirm = await session.post(
      '/auth/magic-link/confirm',
      { token },
      { idempotencyKey: null, ip },
    );
    if (confirm.statusCode !== 200) {
      throw new Error(`magic-link/confirm -> HTTP ${confirm.statusCode}: ${confirm.body}`);
    }
    return session;
  }

  /** A person with a real session cookie, found by email after sign-in; consent recorded unless disabled. */
  async signedIn(
    label: string,
    options: { consent?: boolean | 'outdated'; admin?: boolean; ip?: string } = {},
  ): Promise<{ user: UserFixture; session: BrowserSession }> {
    const email = this.email(label);
    const session = await this.signIn(email, options.ip);
    const id = await this.userIdByEmail(email);
    if (options.admin) await this.sql`UPDATE auth."user" SET is_admin = true WHERE id = ${id}`;
    await this.grantConsent(id, options.consent ?? true);
    return { user: { id, email, displayName: label }, session };
  }

  /** Ensures roles and stack tags exist (the catalog seed may differ between environments). */
  async ensureCatalog(roles: string[], stackTags: string[] = []): Promise<void> {
    for (const [index, code] of roles.entries()) {
      await this.sql`
        INSERT INTO profiles.role (code, name, active, ordinal)
        VALUES (${code}, ${code}, true, ${900 + index}) ON CONFLICT (code) DO NOTHING`;
    }
    for (const code of stackTags) {
      await this.sql`
        INSERT INTO profiles.stack_tag (code, name, active)
        VALUES (${code}, ${code}, true) ON CONFLICT (code) DO NOTHING`;
    }
  }

  /** Runs a maintenance task (e.g. `deletion-scheduler`) in the worker and waits for it to finish. */
  async runMaintenance(task: string): Promise<void> {
    const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = new Queue('maintenance', { connection, prefix: this.queuePrefix });
    try {
      this.maintenanceRuns += 1;
      const job = await queue.add(
        task,
        { requestId: `test-${task}` },
        { jobId: `manual_${task}_${this.maintenanceRuns}`, removeOnComplete: false },
      );
      await waitFor(
        async () => {
          if (await job.isFailed()) throw new Error(`maintenance task ${task} failed`);
          return job.isCompleted();
        },
        30_000,
        50,
      );
    } finally {
      await queue.close();
      connection.disconnect();
    }
  }

  async deadlocks(): Promise<number> {
    const rows = await this
      .sql`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    return Number(rows[0]?.deadlocks ?? 0);
  }

  async close(): Promise<void> {
    await this.resume?.close();
    await this.workerContext?.close();
    for (const extra of this.extraApps) await extra.close();
    await this.testApp.close();
    await this.github?.close();
    await this.mail.close();
    await this.db.drop();
  }
}
