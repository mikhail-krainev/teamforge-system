import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { type MultipartBody, uploadedFiles } from '../../../../platform/http/multipart.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROFILES_MODULE } from '../../public.js';
import { MAX_RESUME_BYTES, sniffResume } from './resume-file.js';
import { ResumeStorage } from './resume-storage.js';
import { ResumeRepository, type ResumeDto, toResumeDto } from './resume.repository.js';

function invalidForm(message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 400, {
    errors: [{ pointer: '/file', code: 'invalid_form', message }],
  });
}

/** Upload, read and delete of resumes (FR-PROF-02, FR-PROF-03, FR-PROF-05). */
@Injectable()
export class ResumeService {
  constructor(
    @Inject(ResumeRepository) private readonly repository: ResumeRepository,
    @Inject(ResumeStorage) private readonly storage: ResumeStorage,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** The only file of the form, checked by size and by its bytes (never by name or Content-Type). */
  private acceptedFile(body: MultipartBody): { bytes: Buffer; mime: string } {
    const files = uploadedFiles(body);
    const file = files.get('file');
    if (file === undefined || files.size !== 1 || Object.keys(body.fields).length > 0) {
      throw invalidForm('Send exactly one file in the "file" field');
    }
    if (file.bytes.length > MAX_RESUME_BYTES) throw new DomainError('FILE_TOO_LARGE', 413);
    const verdict = sniffResume(file.bytes);
    if (!verdict.ok) {
      throw new DomainError('FILE_TYPE_REJECTED', verdict.status, { detail: verdict.reason });
    }
    return { bytes: file.bytes, mime: verdict.mime };
  }

  /** Stores the file, records the upload as `queued` and hands it to `resume-dispatch`. */
  async upload(userId: string, body: MultipartBody): Promise<ResumeDto> {
    const { bytes, mime } = this.acceptedFile(body);
    await this.limiter.enforce('resumeUpload', this.limiter.userSubject(userId));
    const id = randomUUID();
    const storageKey = `res/${randomUUID()}`;
    await this.storage.put(storageKey, bytes, mime);
    try {
      const row = await this.tx.run(async () => {
        const created = await this.repository.insert({
          id,
          userId,
          storageKey,
          mime,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest(),
          createdAt: this.clock.now(),
        });
        await this.publishUpdated(userId, id, 'queued');
        return created;
      });
      await this.dispatch(id);
      return toResumeDto(row);
    } catch (error) {
      await this.storage.remove(storageKey);
      throw error;
    }
  }

  /** Best effort: if the queue is down, `resume-stuck-scan` picks the upload up. */
  private async dispatch(uploadId: string): Promise<void> {
    try {
      await this.queues.add(
        'resume-dispatch',
        'dispatch',
        { uploadId },
        {
          jobId: jobId('dispatch', uploadId),
        },
      );
    } catch {
      // left `queued`; the scan re-queues it
    }
  }

  async latest(userId: string): Promise<ResumeDto> {
    const row = await this.repository.latestOf(userId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    return toResumeDto(row);
  }

  /** Removes the row, the extracted text and the file; someone else's upload is a 404 (IDOR). */
  async delete(userId: string, uploadId: string): Promise<void> {
    const removed = await this.tx.run(async () => {
      const row = await this.repository.deleteOwn(uploadId, userId);
      if (row === undefined) throw new DomainError('NOT_FOUND', 404);
      return row;
    });
    await this.storage.remove(removed.storageKey);
  }

  publishUpdated(userId: string, uploadId: string, status: string): Promise<string> {
    return this.outbox.publish({
      module: PROFILES_MODULE,
      type: 'resume_updated',
      aggregateId: userId,
      payload: { userId, uploadId, status },
    });
  }
}
