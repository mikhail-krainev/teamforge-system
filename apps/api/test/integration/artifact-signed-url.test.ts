import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config/config.js';
import {
  ARTIFACT_PREFIX,
  ArtifactStorage,
  DOWNLOAD_URL_TTL_SECONDS,
} from '../../src/platform/storage/artifact-storage.js';
import { validEnv } from '../helpers/env.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * The download link of an artifact (FR-WORK-05, ADR-0010): a presigned GET on the public files origin,
 * valid for five minutes, forced to be a download. The link is checked against a real S3 (SeaweedFS):
 * a wrong signature would be a 403 there, whatever the structure of the URL looks like.
 */

const logger = { warn: () => undefined } as unknown as PinoLogger;

function storageFor(origin: string, endpoint: string, secret = 'tftestsecretkey0123456789') {
  const env = {
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: 'tftestaccesskey',
    S3_SECRET_KEY: secret,
    FILES_PUBLIC_ORIGIN: origin,
  };
  const config = loadConfig(validEnv(env), 'api');
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  return { storage: new ArtifactStorage(client, config, logger), client };
}

describe('ArtifactStorage.signedDownloadUrl: the shape of the link', () => {
  const { storage, client } = storageFor('https://files.example.test', 'http://127.0.0.1:9000');
  const key = `${ARTIFACT_PREFIX}${randomUUID()}`;
  const signedAt = new Date('2026-10-17T12:00:00.000Z');

  afterAll(() => client.destroy());

  it('points at the files origin, path-style, with the bucket and the key', async () => {
    const url = new URL(await storage.signedDownloadUrl(key, signedAt));
    expect(url.origin).toBe('https://files.example.test');
    expect(url.pathname).toBe(`/artifacts/${key}`);
  });

  it('is a SigV4 query link for five minutes that signs only the host and forces a download', async () => {
    const url = new URL(await storage.signedDownloadUrl(key, signedAt));
    const query = url.searchParams;
    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(query.get('X-Amz-Date')).toBe('20261017T120000Z');
    expect(query.get('X-Amz-Credential')).toBe(
      'tftestaccesskey/20261017/us-east-1/s3/aws4_request',
    );
    expect(query.get('X-Amz-Expires')).toBe(String(DOWNLOAD_URL_TTL_SECONDS));
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(300);
    expect(query.get('X-Amz-SignedHeaders')).toBe('host');
    expect(query.get('response-content-disposition')).toBe('attachment');
    expect(query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(query.has('X-Amz-Security-Token')).toBe(false);
  });

  it('does not reveal the secret key or the endpoint of the storage', async () => {
    const link = await storage.signedDownloadUrl(key, signedAt);
    expect(link).not.toContain('tftestsecretkey');
    expect(link).not.toContain('127.0.0.1');
  });

  it('is the same link for the same instant and a different one for another instant', async () => {
    const first = await storage.signedDownloadUrl(key, signedAt);
    expect(await storage.signedDownloadUrl(key, signedAt)).toBe(first);
    expect(await storage.signedDownloadUrl(key, new Date(signedAt.getTime() + 1_000))).not.toBe(
      first,
    );
  });
});

describeInfra('ArtifactStorage.signedDownloadUrl against a real S3', ['s3'], () => {
  const endpoint = process.env.S3_TEST_ENDPOINT ?? '';
  const secret = process.env.S3_TEST_SECRET_KEY ?? '';
  const { storage, client } = storageFor(endpoint, endpoint, secret);
  const key = `${ARTIFACT_PREFIX}signed-${randomUUID()}`;
  const body = Buffer.from(`signed download ${randomUUID()}`.padEnd(1500, '.'));

  beforeAll(async () => {
    await storage.put(key, body, 'application/pdf');
  });

  afterAll(async () => {
    await storage.removeStrict(key);
    client.destroy();
  });

  it('the link downloads the object, as an attachment', async () => {
    const response = await fetch(await storage.signedDownloadUrl(key, new Date()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
  });

  it('a link with a changed key or a changed signature is refused', async () => {
    const link = new URL(await storage.signedDownloadUrl(key, new Date()));
    const other = new URL(link);
    other.pathname = `/artifacts/${ARTIFACT_PREFIX}other-${randomUUID()}`;
    expect((await fetch(other)).status).toBe(403);
    const forged = new URL(link);
    forged.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    expect((await fetch(forged)).status).toBe(403);
    const longer = new URL(link);
    longer.searchParams.set('X-Amz-Expires', '86400');
    expect((await fetch(longer)).status).toBe(403);
  });

  it('a link signed with another secret is refused', async () => {
    const wrong = storageFor(endpoint, endpoint, 'another-secret-key-0123456789');
    try {
      const response = await fetch(await wrong.storage.signedDownloadUrl(key, new Date()));
      expect(response.status).toBe(403);
    } finally {
      wrong.client.destroy();
    }
  });

  it('a link older than five minutes is refused', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const response = await fetch(await storage.signedDownloadUrl(key, old));
    expect(response.status).toBe(403);
  });
});
