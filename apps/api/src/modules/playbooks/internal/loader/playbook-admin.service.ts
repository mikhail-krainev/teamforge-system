import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { PLAYBOOKS_MODULE } from '../../public.js';
import { PlaybookLoader, type PlaybookSummaryDto, type UploadResult } from './playbook-loader.js';

/** Outbox event of a published playbook (architecture 3.3). */
export const PLAYBOOK_PUBLISHED_TYPE = 'playbook_published';

/** uploadPlaybook and publishPlaybook: the HTTP side of the loader (the CLI uses the loader directly). */
@Injectable()
export class PlaybookAdminService {
  private readonly loader = new PlaybookLoader();

  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
  ) {}

  /** FR-PLAY-01/-02/-07: 422 PLAYBOOK_INVALID, 409 PLAYBOOK_VERSION_NOT_GREATER, or a stored draft. */
  async upload(adminId: string, text: string): Promise<UploadResult> {
    const roles = (await this.profiles.listRoles({ includeInactive: true })).map((r) => r.code);
    return this.tx.run(() => this.loader.upload(this.tx.tx, text, adminId, roles));
  }

  /** FR-PLAY-03/-04: the draft becomes immutable; `playbooks.playbook_published` goes out in the same transaction. */
  publish(playbookId: string): Promise<PlaybookSummaryDto> {
    return this.tx.run(async () => {
      const published = await this.loader.publish(this.tx.tx, playbookId, this.clock.now());
      await this.outbox.publish({
        module: PLAYBOOKS_MODULE,
        type: PLAYBOOK_PUBLISHED_TYPE,
        aggregateId: published.id,
        payload: {
          playbookId: published.id,
          productType: published.productTypeCode,
          version: published.version,
        },
      });
      return published;
    });
  }
}
