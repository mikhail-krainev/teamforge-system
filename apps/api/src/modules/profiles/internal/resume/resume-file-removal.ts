import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROFILES_MODULE } from '../../public.js';
import { ResumeStorage } from './resume-storage.js';
import { ResumeRepository } from './resume.repository.js';

/** Outbox event written in the same transaction that drops the reference to a resume file. */
export const RESUME_FILE_REMOVAL_REQUESTED = 'resume_file_removal_requested';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const ORPHAN_GRACE_MS = HOUR_MS;
export const ORPHAN_BATCH = 500;
const RESUME_PREFIX = 'res/';

/**
 * Guaranteed removal of resume files (FR-PROF-05, S2CR-01): the row change and the "remove this
 * object" event commit together; the events queue retries `removeStrict` until storage confirms.
 */
@Injectable()
export class ResumeFileRemovalConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'profiles.resume-file-removal';
  readonly types = [`${PROFILES_MODULE}.${RESUME_FILE_REMOVAL_REQUESTED}`];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(ResumeStorage) private readonly storage: ResumeStorage,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  /** A storage failure propagates: the delivery is retried. Deleting a missing object is a no-op. */
  async handle(event: OutboxEventData): Promise<void> {
    const key = (event.payload as { storageKey?: unknown }).storageKey;
    if (typeof key !== 'string' || !key.startsWith(RESUME_PREFIX)) return;
    await this.storage.removeStrict(key);
  }
}

/**
 * `orphan-objects` (daily): objects under `res/` older than an hour that no `resume_upload` row
 * points to (crash between `put` and commit, a lost event). Safe to run twice in a row.
 */
@Injectable()
export class OrphanObjectsSweeper implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(ResumeStorage) private readonly storage: ResumeStorage,
    @Inject(ResumeRepository) private readonly repository: ResumeRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'orphan-objects',
      everyMs: DAY_MS,
      run: () => this.sweep(),
    });
  }

  async sweep(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - ORPHAN_GRACE_MS);
    const keys = await this.storage.listOlderThan(RESUME_PREFIX, cutoff, ORPHAN_BATCH);
    if (keys.length === 0) return 0;
    const referenced = await this.tx.run(() => this.repository.referencedKeys(keys));
    const orphans = keys.filter((key) => !referenced.has(key));
    for (const key of orphans) await this.storage.removeStrict(key);
    if (orphans.length > 0) this.logger.warn({ removed: orphans.length }, 'orphan resume objects');
    return orphans.length;
  }
}
