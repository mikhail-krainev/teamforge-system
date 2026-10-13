import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../platform/config/config.js';
import type { MailService } from '../../../../platform/mail/mail.service.js';
import type { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import type { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { SessionRevoker } from '../services/session-revoker.js';
import { DeletionMailConsumer } from './deletion-mail.consumer.js';
import { cancelTokenFor, DELETION_REQUEST_CREATED } from './deletion-notice.js';
import { DeletionRequestService } from './deletion-request.service.js';
import { DeletionSessionsConsumer } from './deletion-sessions.consumer.js';
import type { DeletionRepository, DeletionRow } from './deletion.repository.js';

const SALT = 'unit-test-salt-0123456789abcdef';
const config = { IP_HASH_SALT: SALT, APP_ORIGIN: 'http://localhost:3000' } as unknown as AppConfig;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULED = new Date('2026-10-16T00:00:00Z');

const event = (): OutboxEventData => ({
  id: 'e1',
  module: 'auth',
  type: 'deletion_request_created',
  aggregateId: USER_ID,
  payload: { requestId: REQUEST_ID, userId: USER_ID },
  requestId: null,
});

const repositoryWith = (status: DeletionRow['status'] | undefined) =>
  ({
    findById: vi.fn(async () =>
      status === undefined ? undefined : { id: REQUEST_ID, status, scheduledAt: SCHEDULED },
    ),
  }) as unknown as DeletionRepository;

const consumers = { register: vi.fn() } as unknown as EventConsumers;

describe('cancelTokenFor', () => {
  it('is stable per request, different between requests and between salts', () => {
    const token = cancelTokenFor(SALT, REQUEST_ID);
    expect(token).toBe(cancelTokenFor(SALT, REQUEST_ID));
    expect(token).not.toBe(cancelTokenFor(SALT, USER_ID));
    expect(token).not.toBe(cancelTokenFor('another-salt-0123456789abcdef-xx', REQUEST_ID));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('S2CR-02: DeletionMailConsumer', () => {
  function build(status: DeletionRow['status'] | undefined, email: string | null) {
    const enqueue = vi.fn<(message: { to: string; text: string }) => Promise<void>>(
      async () => undefined,
    );
    const tx = {
      tx: { select: () => ({ from: () => ({ where: async () => [{ email }] }) }) },
    } as unknown as TxRunner;
    const consumer = new DeletionMailConsumer(
      consumers,
      repositoryWith(status),
      tx,
      { enqueue } as unknown as MailService,
      config,
    );
    return { consumer, enqueue };
  }

  it('subscribes to the request-created event', () => {
    expect(build('requested', 'a@example.test').consumer.types).toEqual([DELETION_REQUEST_CREATED]);
  });

  it('queues the mail with the cancel link rebuilt from the request id', async () => {
    const { consumer, enqueue } = build('requested', 'a@example.test');
    await consumer.handle(event());
    expect(enqueue).toHaveBeenCalledOnce();
    const message = enqueue.mock.calls[0]?.[0];
    expect(message?.to).toBe('a@example.test');
    expect(message?.text).toContain(
      `http://localhost:3000/deletion/cancel#token=${cancelTokenFor(SALT, REQUEST_ID)}`,
    );
  });

  it.each([
    ['cancelled', 'cancelled' as const, 'a@example.test'],
    ['already running', 'in_progress' as const, 'a@example.test'],
    ['missing', undefined, 'a@example.test'],
    ['without an e-mail', 'requested' as const, null],
  ])('sends nothing for a request that is %s', async (_name, status, email) => {
    const { consumer, enqueue } = build(status, email);
    await consumer.handle(event());
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('lets a queue failure surface so that the event is retried', async () => {
    const { consumer, enqueue } = build('requested', 'a@example.test');
    enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(consumer.handle(event())).rejects.toThrow('redis down');
    await consumer.handle(event());
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('S2CR-02: DeletionSessionsConsumer', () => {
  function build(status: DeletionRow['status'] | undefined) {
    const revokeUserSessions = vi.fn<(userId: string) => Promise<void>>(async () => undefined);
    const consumer = new DeletionSessionsConsumer(consumers, repositoryWith(status), {
      revokeUserSessions,
    } as unknown as SessionRevoker);
    return { consumer, revokeUserSessions };
  }

  it.each(['requested', 'in_progress'] as const)(
    'revokes the sessions of a %s request',
    async (status) => {
      const { consumer, revokeUserSessions } = build(status);
      await consumer.handle(event());
      expect(revokeUserSessions).toHaveBeenCalledWith(USER_ID);
    },
  );

  it.each([['cancelled' as const], [undefined]])(
    'keeps the sessions of a request that is %s',
    async (status) => {
      const { consumer, revokeUserSessions } = build(status);
      await consumer.handle(event());
      expect(revokeUserSessions).not.toHaveBeenCalled();
    },
  );

  it('a Redis failure surfaces for the retry and repeated runs succeed (idempotent)', async () => {
    const { consumer, revokeUserSessions } = build('requested');
    revokeUserSessions.mockRejectedValueOnce(new Error('redis down'));
    await expect(consumer.handle(event())).rejects.toThrow('redis down');
    await consumer.handle(event());
    await consumer.handle(event());
    expect(revokeUserSessions).toHaveBeenCalledTimes(3);
  });
});

describe('S2CR-02: DeletionRequestService.request writes the event instead of side effects', () => {
  it('commits the request, its token hash and the outbox event together', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    const repository = {
      openOf: async () => undefined,
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return row;
      },
    } as unknown as DeletionRepository;
    const tx = {
      run: async (fn: () => Promise<unknown>) => fn(),
      tx: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
    } as unknown as TxRunner;
    const service = new DeletionRequestService(
      repository,
      tx,
      { lockUser: async () => ({ status: 'active' }) } as never,
      { now: () => new Date('2026-10-13T00:00:00Z') } as never,
      config,
      {} as never,
      {
        publish: async (e: Record<string, unknown>) => {
          published.push(e);
          return 'id';
        },
      } as unknown as OutboxService,
      { get: () => undefined } as never,
    );
    const dto = await service.request(USER_ID, 'user_request');
    const row = inserted[0] as { id: string; cancelTokenHash: Buffer };
    expect(dto.id).toBe(row.id);
    expect(
      row.cancelTokenHash.equals(
        createHash('sha256').update(cancelTokenFor(SALT, row.id)).digest(),
      ),
    ).toBe(true);
    expect(published).toEqual([
      {
        module: 'auth',
        type: 'deletion_request_created',
        aggregateId: USER_ID,
        payload: { requestId: row.id, userId: USER_ID },
      },
    ]);
  });
});
