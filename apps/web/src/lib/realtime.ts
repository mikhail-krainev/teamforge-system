import type { QueryClient, QueryKey } from '@tanstack/react-query';
import {
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHENTICATED,
  WS_LIMITS,
  type ClientMessage,
  type RealtimeChannel,
} from 'shared/realtime';

/**
 * WebSocket client for `/api/ws` (architecture section 9).
 *
 * The socket only says "something changed": the client reads nothing but the event type and the
 * channel and re-reads the data over REST, where rights are checked as usual. The `data` field of
 * a message is never looked at, so a forged or leaked message cannot put content on a screen.
 */

/** What the client keeps from a server message: the event type and the channel it came on. */
export interface RealtimeSignal {
  type: string;
  channel: RealtimeChannel;
}

/** The part of the browser `WebSocket` the client relies on (a fake in tests). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RealtimeOptions {
  /** Resolved at connect time, so the client can be built during server rendering. */
  url: string | (() => string);
  onSignal: (signal: RealtimeSignal) => void;
  /** After a reconnect: events may have been missed, so everything on screen is re-read. */
  onReconnected?: () => void;
  /** The server refused the session (4401) or the consent state (4403): no retries. */
  onRejected?: (code: number) => void;
  createSocket?: (url: string) => SocketLike;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

const SOCKET_OPEN = 1;
const CHANNEL = /^(user|team):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z_]+\.[a-z_]+$/;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Parses one server message; anything that is not a well-formed event is dropped. */
export function parseSignal(raw: unknown): RealtimeSignal | null {
  if (typeof raw !== 'string') return null;
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== 'object' || message === null) return null;
  const { op, channel, type } = message as Record<string, unknown>;
  if (op !== 'event') return null;
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) return null;
  if (typeof type !== 'string' || !EVENT_TYPE.test(type)) return null;
  return { type, channel: channel as RealtimeChannel };
}

/** Exponential backoff with jitter: attempt 0 waits about `base`, doubling up to `max`. */
export function backoffDelay(
  attempt: number,
  baseMs = DEFAULT_BASE_DELAY_MS,
  maxMs = DEFAULT_MAX_DELAY_MS,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

export function realtimeUrl(location: Pick<Location, 'protocol' | 'host'> = window.location) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
}

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private everOpened = false;
  private running = false;
  private readonly channels = new Map<RealtimeChannel, number>();

  constructor(private readonly options: RealtimeOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  /** Reference counted: the channel stays subscribed until every caller has released it. */
  subscribe(channel: RealtimeChannel): () => void {
    const count = this.channels.get(channel) ?? 0;
    if (count === 0 && this.channels.size >= WS_LIMITS.maxSubscriptionsPerConnection) {
      return () => undefined;
    }
    this.channels.set(channel, count + 1);
    if (count === 0) this.send({ op: 'subscribe', channel });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.channels.get(channel) ?? 1) - 1;
      if (left > 0) {
        this.channels.set(channel, left);
        return;
      }
      this.channels.delete(channel);
      this.send({ op: 'unsubscribe', channel });
    };
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === SOCKET_OPEN) this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    if (!this.running) return;
    const create =
      this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const { url } = this.options;
    const socket = create(typeof url === 'function' ? url() : url);
    this.socket = socket;
    socket.onopen = () => {
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      for (const channel of this.channels.keys()) this.send({ op: 'subscribe', channel });
      if (reconnect) this.options.onReconnected?.();
    };
    socket.onmessage = (event) => {
      const signal = parseSignal(event.data);
      if (signal) this.options.onSignal(signal);
    };
    socket.onerror = () => undefined; // `close` always follows and drives the reconnect
    socket.onclose = (event) => {
      this.socket = null;
      if (event.code === WS_CLOSE_UNAUTHENTICATED || event.code === WS_CLOSE_FORBIDDEN) {
        this.running = false;
        this.options.onRejected?.(event.code);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running || this.timer) return;
    const { baseDelayMs, maxDelayMs, random } = this.options;
    const delay = backoffDelay(this.attempt, baseDelayMs, maxDelayMs, random);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

/** Query keys an event invalidates, decided by the caller from the event type and channel only. */
export type KeyResolver = (signal: RealtimeSignal) => readonly QueryKey[];

export function createInvalidator(queryClient: QueryClient, keysFor: KeyResolver) {
  return {
    onSignal(signal: RealtimeSignal): void {
      for (const queryKey of keysFor(signal)) void queryClient.invalidateQueries({ queryKey });
    },
    onReconnected(): void {
      void queryClient.invalidateQueries();
    },
  };
}
