import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { CompletionSnapshot } from '../../../workspace/public.js';
import { CreditRepository } from '../repositories/credit.repository.js';
import { CreditRunRepository } from '../repositories/credit-run.repository.js';
import { AccountVerdicts } from './account-verdicts.service.js';
import { CreditApplier } from './credit-applier.service.js';
import { SnapshotReader } from './snapshot-reader.service.js';

const TEAM_BATCH = 100;

/**
 * `pending-account-recheck` (daily, FR-GH-09, AF-16): a person whose GitHub account was too young or quiet gets
 * his credit once the stored check says it is ready. Per project: the checks and the snapshot are read before the
 * transaction, then lock #11, the status of the run is looked at again (a revoked project is never credited), and
 * `RETURNING` of the promotion decides what the counters move by - so parallel runs and a revocation cannot
 * double or lose a counter (CC-6, CC-12).
 */
@Injectable()
export class PendingRecheckService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(SnapshotReader) private readonly snapshots: SnapshotReader,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(AccountVerdicts) private readonly verdicts: AccountVerdicts,
    @Inject(CreditApplier) private readonly applier: CreditApplier,
  ) {}

  /** Returns the number of people credited. */
  async run(): Promise<number> {
    let promoted = 0;
    let after: string | undefined;
    for (;;) {
      const cursor = after;
      const teamIds = await this.tx.run(() => this.credits.pendingTeamIds(cursor, TEAM_BATCH));
      for (const teamId of teamIds) promoted += await this.recheckTeam(teamId);
      if (teamIds.length < TEAM_BATCH) return promoted;
      after = teamIds.at(-1);
    }
  }

  private async recheckTeam(teamId: string): Promise<number> {
    try {
      const pending = await this.tx.run(() => this.credits.pendingOfTeam(teamId));
      const verdicts = await this.verdicts.load(pending.map((p) => p.userId));
      const ready = pending
        .map((p) => p.userId)
        .filter((u) => verdicts.get(u)?.status === 'eligible');
      if (ready.length === 0) return 0;
      const snapshot = await this.snapshots.read(teamId);
      return await this.tx.run(() => this.promoteInTx(teamId, ready, snapshot));
    } catch (error) {
      this.logger.error({ err: error }, `recheck of ${teamId} failed`);
      return 0;
    }
  }

  private async promoteInTx(
    teamId: string,
    userIds: string[],
    snapshot: CompletionSnapshot,
  ): Promise<number> {
    await this.locks.lockCreditRun(teamId);
    const run = await this.runs.find(teamId);
    if (run?.status !== 'credited') return 0;
    return this.applier.promote(run, snapshot, userIds, this.clock.now());
  }
}
