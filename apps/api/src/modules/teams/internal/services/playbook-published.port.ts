import { Inject, Injectable } from '@nestjs/common';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { PlaybookPublishedPort } from '../../../playbooks/public.js';
import { rebindFormingStubTeams } from '../repositories/stub-rebind.js';

/** Moves forming teams off a playbook without stages in the transaction of the publication. */
@Injectable()
export class StubTeamRebinder implements PlaybookPublishedPort {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  onPublished(input: { productType: string; publishedAt: Date }): Promise<void> {
    return rebindFormingStubTeams(this.tx.tx, input.productType, input.publishedAt);
  }
}
