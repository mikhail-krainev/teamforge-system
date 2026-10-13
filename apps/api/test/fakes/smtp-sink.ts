import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { type MailInbox, type MailMessage, pollUntil, type WaitOptions } from './mail.js';

/** Decodes quoted-printable text (RFC 2045) into a string. */
function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i] ?? '', 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBody(body: string, encoding: string): string {
  const kind = encoding.trim().toLowerCase();
  if (kind === 'quoted-printable') return decodeQuotedPrintable(body);
  if (kind === 'base64') return Buffer.from(body.replaceAll(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

/** RFC 2047 encoded words in header values (`=?UTF-8?B?...?=`). */
function decodeHeader(value: string): string {
  return value.replaceAll(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset, mode, data) =>
    String(mode).toUpperCase() === 'B'
      ? Buffer.from(String(data), 'base64').toString('utf8')
      : decodeQuotedPrintable(String(data).replaceAll('_', ' ')),
  );
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = block.replaceAll(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return headers;
}

function splitPart(raw: string): { headers: Map<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { headers: parseHeaders(raw), body: '' };
  return {
    headers: parseHeaders(raw.slice(0, match.index)),
    body: raw.slice(match.index + match[0].length),
  };
}

function collectBodies(raw: string, out: { text: string; html: string }): void {
  const { headers, body } = splitPart(raw);
  const type = headers.get('content-type') ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      collectBodies(part.replace(/^\r?\n/, ''), out);
    }
    return;
  }
  const decoded = decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit');
  if (/^text\/html/i.test(type)) out.html += decoded;
  else if (/^text\/plain/i.test(type)) out.text += decoded;
}

export function parseMessage(raw: string, recipients: string[], from: string): MailMessage {
  const { headers } = splitPart(raw);
  const bodies = { text: '', html: '' };
  collectBodies(raw, bodies);
  return {
    id: randomUUID(),
    from,
    to: recipients,
    subject: decodeHeader(headers.get('subject') ?? ''),
    text: bodies.text,
    html: bodies.html,
    receivedAt: new Date(),
  };
}

const address = (arg: string): string =>
  (/<([^>]*)>/.exec(arg)?.[1] ?? arg.replace(/^[A-Za-z]+:/, '')).trim().toLowerCase();

/** One SMTP conversation: EHLO, MAIL, RCPT, DATA, QUIT. No TLS, no authentication. */
class SmtpDialog {
  private buffer = '';
  private sender = '';
  private recipients: string[] = [];
  private data: string | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly onMessage: (raw: string, recipients: string[], sender: string) => void,
  ) {}

  greet(): void {
    this.reply('220 localhost ESMTP test sink');
  }

  private reply(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  private command(line: string): void {
    const [verb = ''] = line.split(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO':
        this.socket.write('250-localhost\r\n250 8BITMIME\r\n');
        break;
      case 'MAIL':
        this.sender = address(line.slice(4));
        this.recipients = [];
        this.reply('250 OK');
        break;
      case 'RCPT':
        this.recipients.push(address(line.slice(4)));
        this.reply('250 OK');
        break;
      case 'DATA':
        this.data = '';
        this.reply('354 End data with <CR><LF>.<CR><LF>');
        break;
      case 'QUIT':
        this.reply('221 Bye');
        this.socket.end();
        break;
      default:
        this.reply('250 OK');
    }
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      if (this.data !== null) {
        const end = this.buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        const raw = (this.data + this.buffer.slice(0, end)).replaceAll(/\r\n\.\./g, '\r\n.');
        this.buffer = this.buffer.slice(end + 5);
        this.onMessage(raw, this.recipients, this.sender);
        this.data = null;
        this.reply('250 OK queued');
        continue;
      }
      const eol = this.buffer.indexOf('\r\n');
      if (eol === -1) return;
      const line = this.buffer.slice(0, eol);
      this.buffer = this.buffer.slice(eol + 2);
      this.command(line);
    }
  }
}

/**
 * In-process SMTP server for API tests (the test stack has no Mailpit): accepts any message and keeps
 * it in memory. Point `SMTP_URL` at `sink.smtpUrl`; read mail through the `MailInbox` interface, the
 * same one `MailpitClient` implements.
 */
export class SmtpSink implements MailInbox {
  private readonly messages: MailMessage[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  smtpUrl = '';

  private constructor() {
    this.server = createServer((socket) => this.serve(socket));
  }

  static async start(): Promise<SmtpSink> {
    const sink = new SmtpSink();
    await new Promise<void>((resolve) => sink.server.listen(0, '127.0.0.1', resolve));
    const bound = sink.server.address();
    sink.smtpUrl = `smtp://127.0.0.1:${typeof bound === 'object' && bound ? bound.port : 0}`;
    return sink;
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const dialog = new SmtpDialog(socket, (raw, recipients, sender) =>
      this.messages.push(parseMessage(raw, recipients, sender)),
    );
    socket.on('data', (chunk) => dialog.feed(chunk.toString('utf8')));
    dialog.greet();
  }

  allTo(address_: string): Promise<MailMessage[]> {
    const wanted = address_.toLowerCase();
    return Promise.resolve(this.messages.filter((m) => m.to.includes(wanted)));
  }

  async countTo(address_: string): Promise<number> {
    return (await this.allTo(address_)).length;
  }

  latestTo(address_: string, options: WaitOptions = {}): Promise<MailMessage> {
    const minCount = options.minCount ?? 1;
    return pollUntil(
      async () => {
        const all = await this.allTo(address_);
        return all.length >= minCount ? all[all.length - 1] : undefined;
      },
      options.timeoutMs ?? 20_000,
      `mail to ${address_}`,
    );
  }

  /** Every message received so far (all recipients). */
  all(): readonly MailMessage[] {
    return this.messages;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
