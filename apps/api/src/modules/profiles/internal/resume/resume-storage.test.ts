import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { ResumeStorage } from './resume-storage.js';

type Handler = (command: unknown) => unknown;

function storageWith(handler: Handler) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return handler(command);
    },
  };
  const logger = { warn: vi.fn() };
  const config = { S3_BUCKET_RESUMES: 'resumes-test' };
  const storage = new ResumeStorage(client as never, config as never, logger as never);
  return { storage, sent, logger };
}

const noSuchKey = (): NoSuchKey => new NoSuchKey({ message: 'gone', $metadata: {} });

describe('ResumeStorage', () => {
  it('stores bytes in the resumes bucket with the declared content type', async () => {
    const { storage, sent } = storageWith(() => ({}));
    await storage.put('u/1.pdf', Buffer.from('abc'), 'application/pdf');
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'resumes-test',
      Key: 'u/1.pdf',
      ContentType: 'application/pdf',
    });
  });

  it('reads the bytes of an object', async () => {
    const body = { transformToByteArray: async () => new Uint8Array([1, 2, 3]) };
    const { storage, sent } = storageWith(() => ({ Body: body }));
    expect(await storage.read('k')).toEqual(Buffer.from([1, 2, 3]));
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('reads an empty buffer when the object has no body', async () => {
    const { storage } = storageWith(() => ({}));
    expect(await storage.read('k')).toEqual(Buffer.alloc(0));
  });

  it('returns null for a missing object but rethrows any other failure', async () => {
    const missing = storageWith(() => {
      throw noSuchKey();
    });
    expect(await missing.storage.read('k')).toBeNull();
    const broken = storageWith(() => {
      throw new Error('S3 is down');
    });
    await expect(broken.storage.read('k')).rejects.toThrow('S3 is down');
  });

  it('removeStrict ignores a null key, deletes a real one and surfaces failures', async () => {
    const ok = storageWith(() => ({}));
    await ok.storage.removeStrict(null);
    expect(ok.sent).toHaveLength(0);
    await ok.storage.removeStrict('k');
    expect(ok.sent[0]).toBeInstanceOf(DeleteObjectCommand);
    const broken = storageWith(() => {
      throw new Error('denied');
    });
    await expect(broken.storage.removeStrict('k')).rejects.toThrow('denied');
  });

  it('remove is best effort: a null key is skipped and a failure is only logged', async () => {
    const { storage, sent, logger } = storageWith(() => {
      throw new Error('denied');
    });
    await storage.remove(null);
    expect(sent).toHaveLength(0);
    await expect(storage.remove('k')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('remove deletes the object when storage answers', async () => {
    const { storage, sent, logger } = storageWith(() => ({}));
    await storage.remove('k');
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  describe('listOlderThan', () => {
    const cutoff = new Date('2026-01-10T00:00:00Z');
    const old = new Date('2026-01-01T00:00:00Z');
    const fresh = new Date('2026-01-20T00:00:00Z');

    it('keeps only keys older than the cutoff and skips incomplete entries', async () => {
      const { storage } = storageWith(() => ({
        Contents: [
          { Key: 'p/old', LastModified: old },
          { Key: 'p/new', LastModified: fresh },
          { Key: 'p/nodate' },
          { LastModified: old },
        ],
      }));
      expect(await storage.listOlderThan('p/', cutoff, 10)).toEqual(['p/old']);
    });

    it('tolerates a page without contents', async () => {
      const { storage } = storageWith(() => ({}));
      expect(await storage.listOlderThan('p/', cutoff, 10)).toEqual([]);
    });

    it('follows continuation tokens until it has enough keys and trims to the limit', async () => {
      const pages = [
        { Contents: [{ Key: 'a', LastModified: old }], NextContinuationToken: 't1' },
        {
          Contents: [
            { Key: 'b', LastModified: old },
            { Key: 'c', LastModified: old },
          ],
          NextContinuationToken: 't2',
        },
        { Contents: [{ Key: 'd', LastModified: old }] },
      ];
      const { storage, sent } = storageWith(() => pages.shift());
      expect(await storage.listOlderThan('p/', cutoff, 2)).toEqual(['a', 'b']);
      const first = sent[0] as ListObjectsV2Command;
      const second = sent[1] as ListObjectsV2Command;
      expect(first.input.ContinuationToken).toBeUndefined();
      expect(second.input.ContinuationToken).toBe('t1');
      expect(sent).toHaveLength(2);
    });

    it('stops at the last page when fewer keys than the limit exist', async () => {
      const pages = [
        { Contents: [{ Key: 'a', LastModified: old }], NextContinuationToken: 't1' },
        { Contents: [{ Key: 'b', LastModified: fresh }] },
      ];
      const { storage } = storageWith(() => pages.shift());
      expect(await storage.listOlderThan('p/', cutoff, 5)).toEqual(['a']);
    });
  });
});
