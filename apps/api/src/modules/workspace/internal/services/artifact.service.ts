import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { type MultipartBody, uploadedFiles } from '../../../../platform/http/multipart.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import {
  ARTIFACT_PREFIX,
  ArtifactStorage,
  DOWNLOAD_URL_TTL_SECONDS,
} from '../../../../platform/storage/artifact-storage.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { WORKSPACE_MODULE } from '../../public.js';
import {
  MAX_ARTIFACT_BYTES,
  MIN_ARTIFACT_BYTES,
  safeFileName,
  sniffArtifact,
} from '../domain/artifact-file.js';
import { ArtifactRepository } from '../repositories/artifact.repository.js';
import { ItemGate } from './item-gate.js';
import { toFileDto } from './route-dto.js';
import type { Schema } from 'shared';

export const ARTIFACT_FILE_REMOVAL_REQUESTED = 'artifact_file_removal_requested';
export const ARTIFACT_FILE_UPLOADED = 'artifact_file_uploaded';

type ArtifactFileDto = Schema<'ArtifactFile'>;

interface Accepted {
  bytes: Buffer;
  mime: string;
  name: string;
}

function invalidForm(message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 400, {
    errors: [{ pointer: '/file', code: 'invalid_form', message }],
  });
}

/**
 * uploadArtifactFile, deleteArtifactFile, getArtifactDownloadUrl (FR-WORK-05, FR-PLAY-08). The item
 * is "locked" (#9) by a conditional UPDATE that needs `status = 'open'` and raises its version, so a
 * parallel `PATCH status=done` with the old version loses; the quota (C-48, C-49) is a conditional
 * UPDATE taken after it (architecture 12.3).
 */
@Injectable()
export class ArtifactService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ArtifactStorage) private readonly storage: ArtifactStorage,
    @Inject(ItemGate) private readonly gate: ItemGate,
    @Inject(ArtifactRepository) private readonly files: ArtifactRepository,
  ) {}

  /** The only file of the form, checked by size and by its bytes (never by Content-Type). */
  private accepted(body: MultipartBody): Accepted {
    const parts = uploadedFiles(body);
    const file = parts.get('file');
    if (file === undefined || parts.size !== 1 || Object.keys(body.fields).length > 0) {
      throw invalidForm('Send exactly one file in the "file" field');
    }
    if (file.bytes.length > MAX_ARTIFACT_BYTES) throw new DomainError('FILE_TOO_LARGE', 413);
    if (file.bytes.length < MIN_ARTIFACT_BYTES) throw new DomainError('FILE_TOO_SMALL', 422);
    const verdict = sniffArtifact(file.bytes, file.filename);
    if (!verdict.ok) {
      throw new DomainError('FILE_TYPE_REJECTED', verdict.status, { detail: verdict.reason });
    }
    return { bytes: file.bytes, mime: verdict.mime, name: safeFileName(file.filename) };
  }

  async upload(
    userId: string,
    teamId: string,
    itemId: string,
    body: MultipartBody,
  ): Promise<ArtifactFileDto> {
    const file = this.accepted(body);
    await this.limiter.enforce('artifactUpload', this.limiter.userSubject(userId));
    const storageKey = `${ARTIFACT_PREFIX}${randomUUID()}`;
    await this.storage.put(storageKey, file.bytes, file.mime);
    try {
      return await this.tx.run(() => this.uploadInTx(userId, teamId, itemId, storageKey, file));
    } catch (error) {
      await this.storage.remove(storageKey);
      throw error;
    }
  }

  private async uploadInTx(
    userId: string,
    teamId: string,
    itemId: string,
    storageKey: string,
    file: Accepted,
  ): Promise<ArtifactFileDto> {
    const { item } = await this.gate.open(teamId, itemId, { member: userId });
    if (item.kind !== 'artifact' || item.submission === 'link') {
      throw new DomainError('INVALID_STATE', 409, { detail: 'item_takes_no_files' });
    }
    const now = this.clock.now();
    const version = await this.files.bumpOpenItem(itemId, now);
    if (version === undefined) throw new DomainError('INVALID_STATE', 409);
    if (!(await this.files.reserveQuota(teamId, file.bytes.length))) {
      throw new DomainError('PROJECT_STORAGE_LIMIT', 409);
    }
    const sha256 = createHash('sha256').update(file.bytes).digest();
    const row = await this.files.insert({
      id: randomUUID(),
      teamId,
      checklistItemId: itemId,
      storageKey,
      sha256,
      sizeBytes: file.bytes.length,
      mime: file.mime,
      originalName: file.name,
      uploadedBy: userId,
      createdAt: now,
    });
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'item_updated',
      aggregateId: itemId,
      payload: { teamId, itemId, version },
    });
    // Input of the `sha_dedup` signal (S5-09 / AF-06): the hash, never the bytes.
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: ARTIFACT_FILE_UPLOADED,
      aggregateId: itemId,
      payload: { teamId, itemId, fileId: row.id, sha256: sha256.toString('hex') },
    });
    return toFileDto(row);
  }

  /** Author of the file or the lead of the team; the item must be open (the result stays as submitted). */
  async remove(userId: string, teamId: string, itemId: string, fileId: string): Promise<void> {
    await this.tx.run(async () => {
      const { team, item } = await this.gate.open(teamId, itemId, { member: userId });
      const file = await this.files.find(teamId, itemId, fileId);
      if (file === undefined) throw new DomainError('NOT_FOUND', 404);
      if (file.uploadedBy !== userId && team.leadUserId !== userId) {
        throw new DomainError('FORBIDDEN', 403);
      }
      if (item.status !== 'open') throw new DomainError('INVALID_STATE', 409);
      const now = this.clock.now();
      const version = await this.files.bumpOpenItem(itemId, now);
      if (version === undefined) throw new DomainError('INVALID_STATE', 409);
      if ((await this.files.markDeleted(fileId, now)) === undefined) {
        throw new DomainError('NOT_FOUND', 404);
      }
      await this.files.releaseQuota(teamId, file.sizeBytes);
      await this.outbox.publish({
        module: WORKSPACE_MODULE,
        type: 'item_updated',
        aggregateId: itemId,
        payload: { teamId, itemId, version },
      });
      // Same transaction as the row: the object removal cannot be lost; the consumer retries.
      await this.outbox.publish({
        module: WORKSPACE_MODULE,
        type: ARTIFACT_FILE_REMOVAL_REQUESTED,
        aggregateId: itemId,
        payload: { storageKey: file.storageKey },
      });
    });
  }

  /** A short-lived link on the files origin; membership is checked by the guard, the chain by the query. */
  async downloadUrl(
    teamId: string,
    itemId: string,
    fileId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const file = await this.files.find(teamId, itemId, fileId);
    if (file === undefined) throw new DomainError('NOT_FOUND', 404);
    // The link is checked by the storage against the real time, so the real clock signs it.
    const signedAt = new Date();
    return {
      url: await this.storage.signedDownloadUrl(file.storageKey, signedAt),
      expiresAt: new Date(signedAt.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }
}
