import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { S3 } from './s3.module.js';

/** Every artifact object lives under this prefix (random key, no user-supplied name). */
export const ARTIFACT_PREFIX = 'art/';
/** Lifetime of a download link (FR-WORK-05). */
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Artifact files in the private `artifacts` bucket; downloads go through a signed link on the files origin. */
@Injectable()
export class ArtifactStorage {
  /** Signs for the public files origin; it never sends a request (presigning is local). */
  private readonly filesClient: S3Client;

  constructor(
    @Inject(S3) private readonly client: S3Client,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.filesClient = new S3Client({
      endpoint: config.FILES_PUBLIC_ORIGIN,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET_ARTIFACTS,
        Key: key,
        Body: bytes,
        ContentType: mime,
      }),
    );
  }

  /** A failure must surface so that the event delivery is retried; a missing object is not an error. */
  async removeStrict(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET_ARTIFACTS, Key: key }),
    );
  }

  /** Best effort, only for an upload that never got a row; `orphan-artifact-objects` catches the rest. */
  async remove(key: string): Promise<void> {
    try {
      await this.removeStrict(key);
    } catch (error) {
      this.logger.warn({ err: error }, 'artifact object was not deleted');
    }
  }

  /** Keys under the prefix older than the cutoff (`maxKeys` at most). */
  async listOlderThan(cutoff: Date, maxKeys: number): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.S3_BUCKET_ARTIFACTS,
          Prefix: ARTIFACT_PREFIX,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (
          item.Key !== undefined &&
          item.LastModified !== undefined &&
          item.LastModified < cutoff
        ) {
          keys.push(item.Key);
        }
      }
      token = keys.length < maxKeys ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return keys.slice(0, maxKeys);
  }

  /**
   * Presigned GET on the public files origin (`FILES_PUBLIC_ORIGIN`, never the application origin,
   * SEC-01), signed by the AWS SDK presigner: only `host` is signed and the answer is forced to be a
   * download. `signedAt` is the signing instant; the storage checks the link against its own clock.
   */
  async signedDownloadUrl(
    key: string,
    signedAt: Date,
    ttlSeconds = DOWNLOAD_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.filesClient,
      new GetObjectCommand({
        Bucket: this.config.S3_BUCKET_ARTIFACTS,
        Key: key,
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: ttlSeconds, signingDate: signedAt },
    );
  }
}
