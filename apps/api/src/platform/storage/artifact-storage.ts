import { createHash, createHmac } from 'node:crypto';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { S3 } from './s3.module.js';

/** Every artifact object lives under this prefix (random key, no user-supplied name). */
export const ARTIFACT_PREFIX = 'art/';
/** Lifetime of a download link (FR-WORK-05). */
export const DOWNLOAD_URL_TTL_SECONDS = 300;

const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** Artifact files in the private `artifacts` bucket; downloads go through a signed link on the files origin. */
@Injectable()
export class ArtifactStorage {
  constructor(
    @Inject(S3) private readonly client: S3Client,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

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
   * SigV4 query-string link for GET on the public files origin (`FILES_PUBLIC_ORIGIN`, never the
   * application origin, SEC-01). Only `host` is signed; the answer is forced to be a download.
   */
  signedDownloadUrl(key: string, signedAt: Date, ttlSeconds = DOWNLOAD_URL_TTL_SECONDS): string {
    const origin = new URL(this.config.FILES_PUBLIC_ORIGIN);
    const stamp = signedAt.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = stamp.slice(0, 8);
    const scope = `${day}/us-east-1/s3/aws4_request`;
    const path = `/${this.config.S3_BUCKET_ARTIFACTS}/${key.split('/').map(rfc3986).join('/')}`;
    const query: [string, string][] = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.config.S3_ACCESS_KEY}/${scope}`],
      ['X-Amz-Date', stamp],
      ['X-Amz-Expires', String(ttlSeconds)],
      ['X-Amz-SignedHeaders', 'host'],
      ['response-content-disposition', 'attachment'],
    ];
    const canonicalQuery = query
      .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const canonical = `GET\n${path}\n${canonicalQuery}\nhost:${origin.host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.S3_SECRET_KEY}`, day), 'us-east-1'), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    return `${origin.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}
