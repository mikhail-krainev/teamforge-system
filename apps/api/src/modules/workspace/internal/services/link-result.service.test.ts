import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../../platform/clock/clock.js';
import type { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { ResultListeners } from '../../../../platform/queues/result-listeners.js';
import type { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { LinkCheckResult } from '../../../../link-checker/protocol.js';
import type { LinkStatus } from '../domain/link-policy.js';
import type { LinkCheckRepository } from '../repositories/link-check.repository.js';
import { LinkResultService } from './link-result.service.js';

/*
 * S5-14: the answer of the link-checker is applied to the item only when it is well formed and only
 * when it is about the link the item still has; a malformed answer is dropped (the sweep asks again).
 * The collaborators are plain fakes: the service is glue, its decisions are what is observed.
 */

interface Settled {
  teamId: string;
  itemId: string;
  url: string;
  status: LinkStatus;
}

function build(settleResult: number | null = 5) {
  const settled: Settled[] = [];
  const published: unknown[] = [];
  const registered: unknown[] = [];
  const service = new LinkResultService(
    { register: (listener: unknown) => registered.push(listener) } as unknown as ResultListeners,
    { run: <T>(work: () => Promise<T>) => work() } as unknown as TxRunner,
    { now: () => new Date('2026-03-01T00:00:00Z') } as Clock,
    {
      publish: (event: unknown) => Promise.resolve(void published.push(event)),
    } as unknown as OutboxService,
    {
      settle: (teamId: string, itemId: string, url: string, status: LinkStatus) => {
        settled.push({ teamId, itemId, url, status });
        return Promise.resolve(settleResult ?? undefined);
      },
    } as unknown as LinkCheckRepository,
  );
  return { service, settled, published, registered };
}

const result = (outcome: LinkCheckResult['outcome']) => ({
  teamId: randomUUID(),
  itemId: randomUUID(),
  version: 3,
  url: 'https://example.test/page',
  outcome,
});

describe('LinkResultService (S5-14)', () => {
  it('registers itself as the listener of the link-check queue when the module starts', () => {
    const { service, registered } = build();
    service.onModuleInit();
    expect(registered).toEqual([service]);
  });

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['an empty object', {}],
    [
      'a result without the outcome',
      { teamId: randomUUID(), itemId: randomUUID(), version: 1, url: 'x' },
    ],
    [
      'a result with an unknown reason',
      result({ ok: false, reason: 'SOMETHING_NEW' as never, httpStatus: null }),
    ],
    [
      'a result with a version of zero',
      { ...result({ ok: true, reason: null, httpStatus: 200 }), version: 0 },
    ],
    [
      'a result with ids that are not UUIDs',
      { ...result({ ok: true, reason: null, httpStatus: 200 }), itemId: '1' },
    ],
  ])('%s is dropped: nothing is applied, nothing is published, no error', async (_, raw) => {
    const { service, settled, published } = build();
    await expect(service.handle('job-1', raw)).resolves.toBeUndefined();
    expect(settled).toEqual([]);
    expect(published).toEqual([]);
  });

  it.each([
    [{ ok: true, reason: null, httpStatus: 200 }, 'ok'],
    [{ ok: false, reason: 'HTTP_STATUS', httpStatus: 404 }, 'broken'],
    [{ ok: false, reason: 'TIMEOUT', httpStatus: null }, 'broken'],
    [{ ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null }, 'rejected'],
    [{ ok: false, reason: 'BLOCKED_PORT', httpStatus: null }, 'rejected'],
  ] as const)(
    'the answer %j settles the link as %s and tells the item changed',
    async (outcome, status) => {
      const { service, settled, published } = build();
      const raw = result(outcome);
      await service.handle('job-1', raw);
      expect(settled).toEqual([{ teamId: raw.teamId, itemId: raw.itemId, url: raw.url, status }]);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        type: 'item_updated',
        aggregateId: raw.itemId,
        payload: { teamId: raw.teamId, itemId: raw.itemId, version: 5 },
      });
    },
  );

  it('an answer about a link the item no longer has changes nothing and publishes nothing (apply returns false)', async () => {
    const { service, published } = build(null);
    const raw = result({ ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null });
    await expect(service.apply(raw)).resolves.toBe(false);
    expect(published).toEqual([]);
  });

  it('giving up on a link counts it as broken, a warning, never as rejected', async () => {
    const { service, settled } = build();
    await expect(service.giveUp('t', 'i', 'https://example.test/')).resolves.toBe(true);
    expect(settled).toEqual([
      { teamId: 't', itemId: 'i', url: 'https://example.test/', status: 'broken' },
    ]);
  });
});
