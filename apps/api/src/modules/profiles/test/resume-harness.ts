import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import type { FakeResumeWorker, ParseResult } from '../../../../test/fakes/resume-worker.js';
import type { UploadFile } from '../../../../test/fixtures/clients.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  PROFILE_ROLES,
  PROFILE_STACK,
  RESUME_TEXT,
  ResumeBucket,
  resumeFile,
} from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { waitFor } from '../../../../test/helpers/infra.js';
import { labelOf, type ResumeDto } from './support.js';

export const RESUME_URL = '/v1/me/resume';
export const PROFILE_URL = '/v1/me/profile';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const OK_ANSWER: ParseResult = { v: 1, ok: true, text: RESUME_TEXT, pages: 1 };

export const confirmUrl = (id: string): string => `${RESUME_URL}/${id}/confirmations`;

export interface UploadRow {
  user_id: string;
  storage_key: string | null;
  mime: string;
  size_bytes: number;
  sha256: string;
  status: string;
  failure_reason: string | null;
  extracted_text: string | null;
  keep_file: boolean;
  confirmed_at: Date | null;
}

function resumeQueries(world: () => World) {
  const upload = (user: UserFixture, file: UploadFile = resumeFile('resume.pdf'), key?: string) =>
    world()
      .as(user)
      .upload(RESUME_URL, file, key ? { idempotencyKey: key } : {});

  async function rowOf(id: string): Promise<UploadRow | undefined> {
    const rows = await world().sql<UploadRow[]>`
      SELECT user_id, storage_key, mime, size_bytes::int AS size_bytes, encode(sha256, 'hex') AS sha256,
             status, failure_reason, extracted_text, keep_file, confirmed_at
        FROM profiles.resume_upload WHERE id = ${id}`;
    return rows[0];
  }

  async function uploadCount(userId: string): Promise<number> {
    const rows = await world().sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM profiles.resume_upload WHERE user_id = ${userId}`;
    return rows[0]?.n ?? Number.NaN;
  }

  /** Waits until the pipeline has reached a final state for the upload. */
  async function finalStatus(id: string): Promise<'done' | 'failed'> {
    return waitFor<'done' | 'failed'>(
      async () => {
        const status = (await rowOf(id))?.status;
        return status === 'done' || status === 'failed' ? status : false;
      },
      30_000,
      50,
    );
  }

  return { upload, rowOf, uploadCount, finalStatus };
}

function resumeFlows(world: () => World, queries: ReturnType<typeof resumeQueries>) {
  /** Accepted upload (202) that has been processed to the end. */
  async function uploaded(user: UserFixture, file?: UploadFile): Promise<string> {
    const response = await queries.upload(user, file);
    expect(response.statusCode, response.body).toBe(202);
    const { id } = response.json<ResumeDto>();
    await queries.finalStatus(id);
    return id;
  }

  async function myResume(user: UserFixture): Promise<ResumeDto> {
    const response = await world().as(user).get(RESUME_URL);
    expect(response.statusCode, response.body).toBe(200);
    expectMatchesContract('getMyResume', response);
    return response.json<ResumeDto>();
  }

  /** Waits until none of the users has an upload still in the pipeline. */
  async function settleUsers(userIds: string[]): Promise<void> {
    await waitFor(
      async () => {
        const rows = await world().sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM profiles.resume_upload
           WHERE user_id IN ${world().sql(userIds)} AND status IN ('queued', 'processing')`;
        return rows[0]?.n === 0 || false;
      },
      30_000,
      50,
    );
  }

  return { uploaded, myResume, settleUsers };
}

/**
 * Registers the hooks of a resume test file (a World with the resume-worker stand-in, the S3 reader, the
 * default parser answer restored after every test) and returns the helpers the resume tests share.
 */
export function useResumeWorld() {
  let started: World | undefined;
  let reader: ResumeBucket | undefined;

  beforeAll(async () => {
    started = await World.start({ resumeWorker: true });
    reader = new ResumeBucket();
    await started.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
  });

  afterEach(() => {
    started?.resume?.respondWith(OK_ANSWER);
  });

  afterAll(async () => {
    reader?.destroy();
    await started?.close();
  });

  const world = (): World => {
    if (!started) throw new Error('the test world is not started');
    return started;
  };
  const bucket = (): ResumeBucket => {
    if (!reader) throw new Error('the bucket reader is not created');
    return reader;
  };
  const fake = (): FakeResumeWorker => {
    const worker = world().resume;
    if (!worker) throw new Error('the fake resume worker is not running');
    return worker;
  };
  const newUser = (
    prefix = 'res',
    options: Parameters<World['createUser']>[1] = {},
  ): Promise<UserFixture> => world().createUser(labelOf(prefix), options);

  const queries = resumeQueries(world);
  return { world, bucket, fake, newUser, ...queries, ...resumeFlows(world, queries) };
}
