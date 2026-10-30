import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { resumeUpload } from '../schema/profiles.js';
import type { ContractFailure } from './parse-result.js';
import { assessResume, type ResumeAssessment } from './resume-assessment.js';

export type ResumeRow = typeof resumeUpload.$inferSelect;

/** `ResumeUpload` of the contract. */
export interface ResumeDto {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  failureReason: ContractFailure | null;
  extractedText: string | null;
  suggestions: Record<string, unknown> | null;
  /** Scoring and screening of the text; computed on read, gone together with the text. */
  assessment: ResumeAssessment | null;
  keepFile: boolean;
  createdAt: string;
  processedAt: string | null;
}

function assessmentOf(row: ResumeRow): ResumeAssessment | null {
  if (row.status !== 'done' || row.extractedText === null) return null;
  const stack = (row.suggestions as { stack?: unknown } | null)?.stack;
  const stackTags = Array.isArray(stack) ? stack.length : 0;
  return assessResume(row.extractedText, stackTags, row.processedAt ?? row.createdAt);
}

export function toResumeDto(row: ResumeRow): ResumeDto {
  return {
    assessment: assessmentOf(row),
    id: row.id,
    status: row.status as ResumeDto['status'],
    failureReason: row.failureReason as ContractFailure | null,
    extractedText: row.extractedText,
    suggestions: row.suggestions as Record<string, unknown> | null,
    keepFile: row.keepFile,
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

export interface NewUpload {
  id: string;
  userId: string;
  storageKey: string;
  mime: string;
  sizeBytes: number;
  sha256: Buffer;
  createdAt: Date;
}

export interface Outcome {
  at: Date;
  text?: string;
  suggestions?: Record<string, unknown>;
  failure?: ContractFailure;
}

/** SQL of `profiles.resume_upload`; rows of other users are never selected (filter `user_id`). */
@Injectable()
export class ResumeRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insert(upload: NewUpload): Promise<ResumeRow> {
    const rows = await this.tx.tx
      .insert(resumeUpload)
      .values({ ...upload, status: 'queued' })
      .returning();
    return rows[0] as ResumeRow;
  }

  async latestOf(userId: string): Promise<ResumeRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(resumeUpload)
      .where(eq(resumeUpload.userId, userId))
      .orderBy(desc(resumeUpload.createdAt), desc(resumeUpload.id))
      .limit(1);
    return rows[0];
  }

  /** The caller's own upload, locked for the rest of the transaction. */
  async lockOwn(id: string, userId: string): Promise<ResumeRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(resumeUpload)
      .where(and(eq(resumeUpload.id, id), eq(resumeUpload.userId, userId)))
      .for('update');
    return rows[0];
  }

  async findById(id: string): Promise<ResumeRow | undefined> {
    const rows = await this.tx.tx.select().from(resumeUpload).where(eq(resumeUpload.id, id));
    return rows[0];
  }

  /** queued -> processing; false when the upload is gone or already finished. */
  async markProcessing(id: string): Promise<boolean> {
    const rows = await this.tx.tx
      .update(resumeUpload)
      .set({ status: 'processing' })
      .where(and(eq(resumeUpload.id, id), inArray(resumeUpload.status, ['queued', 'processing'])))
      .returning({ id: resumeUpload.id });
    return rows.length > 0;
  }

  /** Stores the parser outcome unless the upload was finished or deleted in the meantime. */
  async finish(id: string, outcome: Outcome): Promise<ResumeRow | undefined> {
    const done = outcome.failure === undefined;
    const rows = await this.tx.tx
      .update(resumeUpload)
      .set({
        status: done ? 'done' : 'failed',
        failureReason: outcome.failure ?? null,
        extractedText: outcome.text ?? null,
        suggestions: outcome.suggestions ?? null,
        processedAt: outcome.at,
      })
      .where(and(eq(resumeUpload.id, id), inArray(resumeUpload.status, ['queued', 'processing'])))
      .returning();
    return rows[0];
  }

  /** After confirmation: remember the choice; without the file the text and hints go too. */
  async markConfirmed(id: string, keepFile: boolean, at: Date): Promise<void> {
    await this.tx.tx
      .update(resumeUpload)
      .set({
        confirmedAt: at,
        keepFile,
        ...(keepFile ? {} : { storageKey: null, extractedText: null, suggestions: null }),
      })
      .where(eq(resumeUpload.id, id));
  }

  /** Which of the storage keys still belong to a row. */
  async referencedKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.tx.tx
      .select({ key: resumeUpload.storageKey })
      .from(resumeUpload)
      .where(inArray(resumeUpload.storageKey, keys));
    return new Set(rows.flatMap((row) => (row.key === null ? [] : [row.key])));
  }

  async deleteOwn(id: string, userId: string): Promise<ResumeRow | undefined> {
    const rows = await this.tx.tx
      .delete(resumeUpload)
      .where(and(eq(resumeUpload.id, id), eq(resumeUpload.userId, userId)))
      .returning();
    return rows[0];
  }

  /** Uploads that never reached a final state (lost job, crashed worker). */
  async stuckBefore(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ id: resumeUpload.id })
      .from(resumeUpload)
      .where(
        and(
          inArray(resumeUpload.status, ['queued', 'processing']),
          lt(resumeUpload.createdAt, cutoff),
          sql`${resumeUpload.storageKey} IS NOT NULL`,
        ),
      )
      .orderBy(resumeUpload.createdAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }
}
