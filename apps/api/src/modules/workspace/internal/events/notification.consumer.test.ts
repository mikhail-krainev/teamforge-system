import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../../platform/config/config.js';
import type { OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { NotificationConsumer } from './notification.consumer.js';

interface QueuedJob {
  queue: string;
  name: string;
  jobId: string;
}

/** A consumer wired with fakes; the repository returns every draft as "new", as after a rolled-back inbox transaction. */
function build() {
  const jobs: QueuedJob[] = [];
  const consumer = new NotificationConsumer(
    { register: () => undefined } as never,
    {
      insertNew: (rows: { id: string; userId: string; dedupeKey: string }[]) =>
        Promise.resolve(rows),
    } as never,
    { publishMany: () => Promise.resolve() } as never,
    {
      add: (queue: string, name: string, _data: unknown, options: { jobId: string }) => {
        // Like BullMQ: a second add with an existing id is ignored.
        if (!jobs.some((j) => j.jobId === options.jobId)) {
          jobs.push({ queue, name, jobId: options.jobId });
        }
        return Promise.resolve();
      },
    } as never,
    { seal: (text: string) => `sealed:${text.length}` } as never,
    {} as never,
    { getMailRecipient: () => Promise.resolve('a@example.test') } as never,
    { now: () => new Date('2026-10-14T10:00:00Z') } as never,
    { APP_ORIGIN: 'https://app.example.test' } as unknown as AppConfig,
  );
  return { consumer, jobs };
}

const offerEvent: OutboxEventData = {
  id: '0194a000-0000-7000-8000-000000000001',
  module: 'teams',
  type: 'offer_created',
  aggregateId: '0194a000-0000-7000-8000-000000000002',
  payload: {
    offerId: '0194a000-0000-7000-8000-000000000002',
    teamId: '0194a000-0000-7000-8000-000000000003',
    seatId: '0194a000-0000-7000-8000-000000000004',
    userId: '0194a000-0000-7000-8000-000000000005',
    direction: 'lead_to_user',
  },
  requestId: null,
};

describe('NotificationConsumer mail (S3CR-03)', () => {
  it('processing the same event twice enqueues one mail job with a deterministic id', async () => {
    const { consumer, jobs } = build();
    await consumer.handle(offerEvent);
    await consumer.handle(offerEvent);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      queue: 'notifications',
      name: 'send-mail',
      jobId: `mail_0194a000-0000-7000-8000-000000000005_seat_offer-0194a000-0000-7000-8000-000000000002`,
    });
  });
});
