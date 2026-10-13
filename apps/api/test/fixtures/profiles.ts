import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import type postgres from 'postgres';
import type { UploadFile } from './clients.js';

const FILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');

/** Text inside `files/resume.pdf` and `files/resume.docx` (see files/generate.mjs). */
export const RESUME_TEXT =
  'Ivan Petrov. Backend developer. TypeScript, PostgreSQL, Redis. 2024-2026 Teamforge.';

export type ResumeFixtureName =
  | 'resume.pdf'
  | 'resume.docx'
  | 'no-text.pdf'
  | 'pdf-bomb.pdf'
  | 'docx-bomb.docx'
  | 'encrypted.pdf'
  | 'renamed-exe.pdf'
  | 'empty.pdf';

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function resumeBytes(name: ResumeFixtureName): Buffer {
  return readFileSync(path.join(FILES_DIR, name));
}

/** A resume fixture as the multipart part of `uploadResume`. */
export function resumeFile(
  name: ResumeFixtureName,
  overrides: Partial<UploadFile> = {},
): UploadFile {
  return {
    filename: name,
    contentType: MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
    data: resumeBytes(name),
    ...overrides,
  };
}

export interface ProfileInputBody {
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  portfolioUrl: string | null;
  stack: string[];
  rolePrefs: { roleCode: string; level: 'beginner' | 'junior' | 'middle' }[];
  experience: { title: string; description?: string; from: string; to?: string | null }[];
  strengths: string[];
  weaknesses: string[];
  version: number | null;
}

/** Catalog entries `profileInput` uses; `World.ensureCatalog(PROFILE_ROLES, PROFILE_STACK)` creates them. */
export const PROFILE_ROLES = ['backend', 'frontend', 'pm'];
export const PROFILE_STACK = ['typescript', 'react', 'postgresql'];

/** A valid `ProfileInput` (FR-PROF-01): 2 roles with priorities, 3 stack tags, one experience. */
export function profileInput(overrides: Partial<ProfileInputBody> = {}): ProfileInputBody {
  return {
    displayName: 'Иван Петров',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 12,
    portfolioUrl: 'https://example.test/ivan',
    stack: [...PROFILE_STACK],
    rolePrefs: [
      { roleCode: 'backend', level: 'junior' },
      { roleCode: 'frontend', level: 'beginner' },
    ],
    experience: [
      {
        title: 'Учебный проект',
        description: 'REST API на TypeScript',
        from: '2024-09-01',
        to: null,
      },
    ],
    strengths: ['Быстро учусь'],
    weaknesses: ['Тяну с документацией'],
    version: null,
    ...overrides,
  };
}

/** Inserts a profile with its child rows directly (fixtures do not go through HTTP). */
export async function insertProfile(
  sql: postgres.Sql,
  userId: string,
  overrides: Partial<ProfileInputBody> = {},
): Promise<void> {
  const p = profileInput(overrides);
  await sql`
    INSERT INTO profiles.profile (user_id, display_name, timezone, hours_per_week, portfolio_url,
                                  strengths, weaknesses, version, updated_at)
    VALUES (${userId}, ${p.displayName}, ${p.timezone}, ${p.hoursPerWeek}, ${p.portfolioUrl},
            ${sql.json(p.strengths)}, ${sql.json(p.weaknesses)}, 1, now())`;
  for (const [ordinal, pref] of p.rolePrefs.entries()) {
    await sql`
      INSERT INTO profiles.profile_role_pref (user_id, role_code, level, ordinal)
      VALUES (${userId}, ${pref.roleCode}, ${pref.level}, ${ordinal})`;
  }
  for (const code of p.stack) {
    await sql`INSERT INTO profiles.profile_stack (user_id, stack_tag_code) VALUES (${userId}, ${code})`;
  }
  for (const [ordinal, item] of p.experience.entries()) {
    await sql`
      INSERT INTO profiles.profile_experience (id, user_id, title, description, period_from, period_to, ordinal)
      VALUES (${randomUUID()}, ${userId}, ${item.title}, ${item.description ?? null}, ${item.from},
              ${item.to ?? null}, ${ordinal})`;
  }
}

export interface ResumeRowOptions {
  status?: 'queued' | 'processing' | 'done' | 'failed';
  failureReason?: string | null;
  extractedText?: string | null;
  suggestions?: Record<string, unknown> | null;
  keepFile?: boolean;
  storageKey?: string | null;
}

/** Inserts a `resume_upload` row (e.g. already parsed) without running the pipeline. */
export async function insertResume(
  sql: postgres.Sql,
  userId: string,
  options: ResumeRowOptions = {},
): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? 'done';
  const text =
    options.extractedText === undefined && status === 'done'
      ? RESUME_TEXT
      : (options.extractedText ?? null);
  const suggestions =
    options.suggestions === undefined && status === 'done'
      ? { stack: ['typescript', 'postgresql'] }
      : (options.suggestions ?? null);
  await sql`
    INSERT INTO profiles.resume_upload (id, user_id, storage_key, mime, size_bytes, sha256, status,
                                        failure_reason, extracted_text, suggestions, keep_file,
                                        created_at, processed_at)
    VALUES (${id}, ${userId}, ${options.storageKey === undefined ? `res/${randomUUID()}` : options.storageKey},
            ${MIME.pdf ?? ''}, 741, ${createHash('sha256').update(id).digest()}, ${status},
            ${options.failureReason ?? null}, ${text},
            ${suggestions === null ? null : sql.json(suggestions as never)}, ${options.keepFile ?? false},
            now(), ${status === 'queued' || status === 'processing' ? null : sql`now()`})`;
  return id;
}

/** Minimal S3 reader for the resume bucket of the test stack (SeaweedFS, `S3_TEST_*`). */
export class ResumeBucket {
  private readonly client = new S3Client({
    endpoint: process.env.S3_TEST_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? '',
      secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? '',
    },
  });

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: 'resumes', Key: key }));
      return true;
    } catch (error) {
      if (error instanceof NotFound || error instanceof NoSuchKey) return false;
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async read(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: 'resumes', Key: key }));
    return Buffer.from((await response.Body?.transformToByteArray()) ?? []);
  }

  destroy(): void {
    this.client.destroy();
  }
}
