import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { ResumeConfirmService } from './resume-confirm.service.js';
import {
  ORPHAN_GRACE_MS,
  OrphanObjectsSweeper,
  RESUME_FILE_REMOVAL_REQUESTED,
  ResumeFileRemovalConsumer,
} from './resume-file-removal.js';
import { ResumePipeline } from './resume-pipeline.js';
import { ResumeService } from './resume.service.js';

const event = (storageKey: unknown): OutboxEventData => ({
  id: 'e1',
  module: 'profiles',
  type: RESUME_FILE_REMOVAL_REQUESTED,
  aggregateId: 'u1',
  payload: { storageKey },
  requestId: null,
});

const tx = { run: <T>(fn: () => Promise<T>): Promise<T> => fn() };

describe('ResumeFileRemovalConsumer (S2CR-01)', () => {
  const build = (removeStrict: (key: string) => Promise<void>) =>
    new ResumeFileRemovalConsumer({} as never, { removeStrict } as never);

  it('removes the object named in the event', async () => {
    const removeStrict = vi.fn(async () => undefined);
    await build(removeStrict).handle(event('res/abc'));
    expect(removeStrict).toHaveBeenCalledWith('res/abc');
  });

  it('lets a storage failure through so that the delivery is retried', async () => {
    const consumer = build(async () => {
      throw new Error('S3 is down');
    });
    await expect(consumer.handle(event('res/abc'))).rejects.toThrow('S3 is down');
  });

  it('ignores a payload that is not a resume key', async () => {
    const removeStrict = vi.fn(async () => undefined);
    const consumer = build(removeStrict);
    await consumer.handle(event('other/abc'));
    await consumer.handle(event(42));
    expect(removeStrict).not.toHaveBeenCalled();
  });

  it('subscribes to the profiles event only', () => {
    expect(build(async () => undefined).types).toEqual([
      `profiles.${RESUME_FILE_REMOVAL_REQUESTED}`,
    ]);
  });
});

describe('OrphanObjectsSweeper (orphan-objects)', () => {
  const now = new Date('2026-10-13T00:00:00Z');

  function build(keys: string[], referenced: string[], failOn?: string) {
    const removed: string[] = [];
    const listOlderThan = vi.fn(async () => keys);
    const storage = {
      listOlderThan,
      removeStrict: async (key: string) => {
        if (key === failOn) throw new Error('S3 is down');
        removed.push(key);
      },
    };
    const repository = { referencedKeys: async () => new Set(referenced) };
    const registered: { name: string; everyMs: number }[] = [];
    const sweeper = new OrphanObjectsSweeper(
      { register: (task: { name: string; everyMs: number }) => registered.push(task) } as never,
      storage as never,
      repository as never,
      tx as never,
      { now: () => now } as never,
      { warn: vi.fn() } as never,
    );
    return { sweeper, removed, listOlderThan, registered };
  }

  it('removes objects without a row and keeps referenced ones', async () => {
    const { sweeper, removed } = build(['res/a', 'res/b', 'res/c'], ['res/b']);
    expect(await sweeper.sweep()).toBe(2);
    expect(removed).toEqual(['res/a', 'res/c']);
  });

  it('looks only at objects older than the grace period', async () => {
    const { sweeper, listOlderThan } = build([], []);
    await sweeper.sweep();
    expect(listOlderThan).toHaveBeenCalledWith(
      'res/',
      new Date(now.getTime() - ORPHAN_GRACE_MS),
      expect.any(Number),
    );
  });

  it('is registered as a daily maintenance task', () => {
    const { sweeper, registered } = build([], []);
    sweeper.onModuleInit();
    expect(registered).toEqual([
      expect.objectContaining({ name: 'orphan-objects', everyMs: 24 * 60 * 60 * 1000 }),
    ]);
  });

  it('surfaces a storage failure so that the task is retried', async () => {
    const { sweeper } = build(['res/a'], [], 'res/a');
    await expect(sweeper.sweep()).rejects.toThrow('S3 is down');
  });
});

describe('removal is recorded in the same transaction (S2CR-01)', () => {
  function resumeService(storageKey: string | null, publish: ReturnType<typeof vi.fn>) {
    const remove = vi.fn();
    const service = new ResumeService(
      { deleteOwn: async () => ({ storageKey }) } as never,
      { remove } as never,
      tx as never,
      { publish } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, remove };
  }

  it('deleteResume publishes the removal event and no longer touches storage', async () => {
    const publish = vi.fn(async () => 'id');
    const { service, remove } = resumeService('res/k1', publish);
    await service.delete('u1', 'up1');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RESUME_FILE_REMOVAL_REQUESTED,
        payload: { storageKey: 'res/k1' },
      }),
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('a row that had no file records no event', async () => {
    const publish = vi.fn();
    const { service } = resumeService(null, publish);
    await service.delete('u1', 'up1');
    expect(publish).not.toHaveBeenCalled();
  });

  function confirmService(upload: Record<string, unknown>) {
    const requestFileRemoval = vi.fn(async () => undefined);
    const markConfirmed = vi.fn(async () => undefined);
    const service = new ResumeConfirmService(
      { lockOwn: async () => upload, markConfirmed } as never,
      { find: async () => ({ version: 1 }) } as never,
      { save: async () => ({ version: 2 }) } as never,
      { requestFileRemoval } as never,
      tx as never,
      { now: () => new Date() } as never,
    );
    return { service, requestFileRemoval, markConfirmed };
  }
  const body = { confirmedFields: { stack: ['go'] }, keepFile: false, profileVersion: 1 };

  it('confirm with keepFile=false records the removal event', async () => {
    const { service, requestFileRemoval } = confirmService({
      status: 'done',
      confirmedAt: null,
      storageKey: 'res/k2',
    });
    await service.confirm('u1', 'up1', body);
    expect(requestFileRemoval).toHaveBeenCalledWith('u1', 'res/k2');
  });

  it('S2CR-05: an already confirmed upload -> 409 INVALID_STATE, nothing is written', async () => {
    const { service, requestFileRemoval, markConfirmed } = confirmService({
      status: 'done',
      confirmedAt: new Date(),
      storageKey: null,
    });
    await expect(service.confirm('u1', 'up1', body)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(markConfirmed).not.toHaveBeenCalled();
    expect(requestFileRemoval).not.toHaveBeenCalled();
  });
});

describe('ResumePipeline.onExhausted (S2CR-06)', () => {
  it('an infrastructure failure is not reported as a corrupted file', async () => {
    const finish = vi.fn(async () => ({ userId: 'u1', status: 'failed' }));
    const pipeline = new ResumePipeline(
      {} as never,
      {} as never,
      { finish } as never,
      {} as never,
      {} as never,
      { publishUpdated: async () => 'id' } as never,
      {} as never,
      tx as never,
      { now: () => new Date() } as never,
      { error: vi.fn(), info: vi.fn() } as never,
    );
    await pipeline.onExhausted({ data: { uploadId: 'up1' } } as never, new Error('redis down'));
    expect(finish).toHaveBeenCalledWith('up1', expect.objectContaining({ failure: 'timeout' }));
  });
});
