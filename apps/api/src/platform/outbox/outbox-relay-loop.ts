import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { REDIS } from '../redis/redis.module.js';
import { OutboxRelay } from './outbox-relay.js';
import { OUTBOX_KICK_CHANNEL, OUTBOX_POLL_MS } from './outbox.types.js';

/** Runs the relay every 250 ms and immediately on the `outbox:kick` Redis signal (worker only). */
@Injectable()
export class OutboxRelayLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private subscriber: Redis | undefined;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(
    @Inject(OutboxRelay) private readonly relay: OutboxRelay,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', () => void this.tick());
    void this.subscriber.subscribe(OUTBOX_KICK_CHANNEL).catch(() => undefined);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, OUTBOX_POLL_MS);
  }

  /** Drains the table; overlapping triggers collapse into one extra pass. */
  async tick(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.drain();
      } while (this.rerun && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    try {
      let published = 0;
      do {
        published = await this.relay.runOnce();
      } while (published > 0 && !this.stopped);
    } catch (error) {
      this.logger.error({ err: error }, 'outbox relay pass failed');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.subscriber?.quit().catch(() => undefined);
  }
}
