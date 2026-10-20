import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { ARTIFACT_PREFIX, ArtifactStorage } from '../../../../platform/storage/artifact-storage.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { ArtifactRepository } from '../repositories/artifact.repository.js';
import { ARTIFACT_FILE_REMOVAL_REQUESTED } from '../services/artifact.service.js';

const HOUR_MS = 60 * 60 * 1000;
export const ARTIFACT_ORPHAN_GRACE_MS = HOUR_MS;
export const ARTIFACT_ORPHAN_BATCH = 500;

/** Guaranteed removal of the object of a deleted file: the row change and the event commit together. */
@Injectable()
export class ArtifactFileRemovalConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.artifact-file-removal';
  readonly types = [`${WORKSPACE_MODULE}.${ARTIFACT_FILE_REMOVAL_REQUESTED}`];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(ArtifactStorage) private readonly storage: ArtifactStorage,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  /** A storage failure propagates: the delivery is retried. Deleting a missing object is a no-op. */
  async handle(event: OutboxEventData): Promise<void> {
    const key = (event.payload as { storageKey?: unknown }).storageKey;
    if (typeof key !== 'string' || !key.startsWith(ARTIFACT_PREFIX)) return;
    await this.storage.removeStrict(key);
  }
}

/**
 * `orphan-artifact-objects` (daily, the artifact twin of the resume `orphan-objects`): objects under
 * `art/` older than an hour that no live `artifact_file` row points to (a crash between `put` and
 * commit, a lost event). Safe to run twice in a row.
 */
@Injectable()
export class OrphanArtifactSweeper implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(ArtifactStorage) private readonly storage: ArtifactStorage,
    @Inject(ArtifactRepository) private readonly files: ArtifactRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'orphan-artifact-objects',
      everyMs: 24 * HOUR_MS,
      run: () => this.sweep(),
    });
  }

  async sweep(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - ARTIFACT_ORPHAN_GRACE_MS);
    const keys = await this.storage.listOlderThan(cutoff, ARTIFACT_ORPHAN_BATCH);
    if (keys.length === 0) return 0;
    const referenced = await this.tx.run(() => this.files.referencedKeys(keys));
    const orphans = keys.filter((key) => !referenced.has(key));
    for (const key of orphans) await this.storage.removeStrict(key);
    if (orphans.length > 0)
      this.logger.warn({ removed: orphans.length }, 'orphan artifact objects');
    return orphans.length;
  }
}
