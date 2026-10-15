import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  parseSignal,
  RealtimeClient,
  realtimeUrl,
  type RealtimeSignal,
  type SocketLike,
} from './realtime';

const USER = 'user:0192f0a0-7c1e-7b3a-8d2f-3a4b5c6d7e8f' as const;
const TEAM = 'team:0192f0a0-7c1e-7b3a-8d2f-00000000a001' as const;

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

function make(extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const signals: RealtimeSignal[] = [];
  const onReconnected = vi.fn();
  const onRejected = vi.fn();
  const client = new RealtimeClient({
    url: 'ws://host/api/ws',
    onSignal: (s) => signals.push(s),
    onReconnected,
    onRejected,
    createSocket: (url) => new FakeSocket(url),
    random: () => 1,
    ...extra,
  });
  return { client, signals, onReconnected, onRejected };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('parseSignal', () => {
  it('keeps only the type and the channel, never the data', () => {
    const signal = parseSignal(
      JSON.stringify({ op: 'event', channel: TEAM, type: 'vote.updated', data: { x: 1 }, at: 'z' }),
    );
    expect(signal).toEqual({ type: 'vote.updated', channel: TEAM });
  });

  it.each([
    ['not json', 'oops'],
    ['a binary frame', new ArrayBuffer(2)],
    ['an error message', JSON.stringify({ op: 'error', code: 'FORBIDDEN' })],
    ['a foreign channel', JSON.stringify({ op: 'event', channel: 'admin:1', type: 'a.b' })],
    ['a bad type', JSON.stringify({ op: 'event', channel: TEAM, type: '<script>' })],
    ['null', 'null'],
  ])('drops %s', (_name, raw) => {
    expect(parseSignal(raw)).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('doubles up to the cap and keeps jitter within half of the ceiling', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(1, 1000, 30_000, () => 1)).toBe(2000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelay(10, 1000, 30_000, () => 0)).toBe(15_000);
  });
});

describe('realtimeUrl', () => {
  it('uses wss on https and the same host', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'a.example' })).toBe('wss://a.example/api/ws');
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/api/ws',
    );
  });
});

describe('RealtimeClient', () => {
  it('subscribes to the user and team channels on open and delivers signals', () => {
    const { client, signals } = make();
    client.subscribe(USER);
    client.start();
    last().open();
    client.subscribe(TEAM);
    expect(last().sent).toEqual([
      { op: 'subscribe', channel: USER },
      { op: 'subscribe', channel: TEAM },
    ]);
    last().message({ op: 'event', channel: TEAM, type: 'member.joined', data: {}, at: '' });
    last().message('garbage');
    expect(signals).toEqual([{ type: 'member.joined', channel: TEAM }]);
  });

  it('shares a channel between callers and unsubscribes after the last release', () => {
    const { client } = make();
    client.start();
    last().open();
    const a = client.subscribe(TEAM);
    const b = client.subscribe(TEAM);
    a();
    a();
    expect(last().sent).toEqual([{ op: 'subscribe', channel: TEAM }]);
    b();
    expect(last().sent).toEqual([
      { op: 'subscribe', channel: TEAM },
      { op: 'unsubscribe', channel: TEAM },
    ]);
  });

  it('reconnects with growing delays, resubscribes and reports the reconnect', () => {
    const { client, onReconnected } = make({ baseDelayMs: 1000 });
    client.subscribe(TEAM);
    client.start();
    last().open();
    expect(onReconnected).not.toHaveBeenCalled();

    last().drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);

    last().drop(); // never opened: the next wait doubles
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);

    last().open();
    expect(last().sent).toEqual([{ op: 'subscribe', channel: TEAM }]);
    expect(onReconnected).toHaveBeenCalledTimes(1);

    last().drop(); // a successful open reset the backoff
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it.each([4401, 4403])('does not retry after close code %i', (code) => {
    const { client, onRejected } = make();
    client.start();
    last().open();
    last().drop(code);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(onRejected).toHaveBeenCalledWith(code);
  });

  it('stop closes the socket and cancels a pending reconnect', () => {
    const { client } = make();
    client.start();
    last().open();
    last().drop();
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);

    client.start();
    const second = last();
    client.stop();
    expect(second.closed).toBe(true);
  });
});
