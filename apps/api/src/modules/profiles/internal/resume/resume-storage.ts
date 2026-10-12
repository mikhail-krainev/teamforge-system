import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { S3 } from '../../../../platform/storage/s3.module.js';

/** Resume files in the private `resumes` bucket, outside every application directory (SEC-01). */
@Injectable()
export class ResumeStorage {
  constructor(
    @Inject(S3) private readonly client: S3Client,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET_RESUMES,
        Key: key,
        Body: bytes,
        ContentType: mime,
      }),
    );
  }

  /** The bytes of an object, or null when it does not exist. */
  async read(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.S3_BUCKET_RESUMES, Key: key }),
      );
      return Buffer.from((await response.Body?.transformToByteArray()) ?? []);
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  /** Deletion of personal data (FR-AUTH-09): a failure must surface so that the step is retried. */
  async removeStrict(key: string | null): Promise<void> {
    if (key === null) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET_RESUMES, Key: key }),
    );
  }

  /** Best effort: a leftover object is removed later by the `orphan-objects` task. */
  async remove(key: string | null): Promise<void> {
    if (key === null) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET_RESUMES, Key: key }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'resume object was not deleted');
    }
  }
}
