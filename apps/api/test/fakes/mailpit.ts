import { type MailInbox, type MailMessage, pollUntil, type WaitOptions } from './mail.js';

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
  From: { Address: string };
  To: { Address: string }[];
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  Date: string;
  From: { Address: string };
  To: { Address: string }[];
  Text: string;
  HTML: string;
}

/**
 * Mailpit client (the SMTP double of docker-compose.yml): reads mail through its REST API
 * (`/api/v1/search`, `/api/v1/message/{id}`). `baseUrl` is the Mailpit UI/API origin, for example
 * `http://localhost:18025` in the Playwright `e2e` project.
 */
export class MailpitClient implements MailInbox {
  constructor(private readonly baseUrl: string) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async allTo(address: string): Promise<MailMessage[]> {
    const query = encodeURIComponent(`to:"${address}"`);
    const found = await this.json<{ messages: MailpitSummary[] }>(
      `/api/v1/search?query=${query}&limit=200`,
    );
    const messages = await Promise.all(
      found.messages.map((summary) => this.json<MailpitMessage>(`/api/v1/message/${summary.ID}`)),
    );
    return messages
      .map((m) => ({
        id: m.ID,
        from: m.From.Address,
        to: m.To.map((t) => t.Address),
        subject: m.Subject,
        text: m.Text,
        html: m.HTML,
        receivedAt: new Date(m.Date),
      }))
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async countTo(address: string): Promise<number> {
    return (await this.allTo(address)).length;
  }

  latestTo(address: string, options: WaitOptions = {}): Promise<MailMessage> {
    const minCount = options.minCount ?? 1;
    return pollUntil(
      async () => {
        const all = await this.allTo(address);
        return all.length >= minCount ? all[all.length - 1] : undefined;
      },
      options.timeoutMs ?? 20_000,
      `mail to ${address}`,
    );
  }

  /** Removes every message (call before a scenario that counts mail). */
  async clear(): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/messages`, { method: 'DELETE' });
  }
}
