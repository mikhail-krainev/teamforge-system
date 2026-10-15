import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.js';
import { MailService } from './mail.service.js';

interface Added {
  queue: string;
  name: string;
  data: { sealed: string };
  options: { jobId: string };
}

function build() {
  const added: Added[] = [];
  const service = new MailService(
    {} as unknown as AppConfig,
    {
      add: (queue: string, name: string, data: { sealed: string }, options: { jobId: string }) => {
        added.push({ queue, name, data, options });
        return Promise.resolve();
      },
    } as never,
    { seal: (text: string) => `sealed(${text})` } as never,
  );
  return { service, added };
}

const message = { to: 'a@example.test', subject: 's', text: 't' };

describe('MailService.enqueue', () => {
  it('uses the given deterministic job id and seals the message', async () => {
    const { service, added } = build();
    await service.enqueue(message, { jobId: 'mail_user_key' });
    expect(added).toHaveLength(1);
    expect(added[0]?.options.jobId).toBe('mail_user_key');
    expect(added[0]?.queue).toBe('notifications');
    expect(added[0]?.name).toBe('send-mail');
    expect(added[0]?.data.sealed).toBe(`sealed(${JSON.stringify(message)})`);
  });

  it('without a job id every call gets a new random one', async () => {
    const { service, added } = build();
    await service.enqueue(message);
    await service.enqueue(message);
    const [first, second] = added.map((a) => a.options.jobId);
    expect(first).toMatch(/^mail_/);
    expect(first).not.toBe(second);
  });

  it('rejects a job id BullMQ would refuse', async () => {
    const { service, added } = build();
    await expect(service.enqueue(message, { jobId: 'a:b' })).rejects.toThrow();
    await expect(service.enqueue(message, { jobId: '123' })).rejects.toThrow();
    expect(added).toHaveLength(0);
  });
});
