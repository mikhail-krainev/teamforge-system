import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { FraudRepository } from '../repositories/fraud.repository.js';
import { CreditRunService } from '../services/credit-run.service.js';

type DisputeDto = Ok<'createDispute'>;

const invalidState = (): DomainError => new DomainError('INVALID_STATE', 409);

/** FR-REW-11: a project can be disputed in the cooling, and while its case is open; never after the decision. */
function disputable(run: CreditRunRow, now: Date): boolean {
  if (run.status === 'frozen') return true;
  return run.status === 'cooling' && now.getTime() < run.coolingUntil.getTime();
}

/**
 * `createDispute` (S7-05, FR-REW-11, CC-12): a participant disputes the project once. Lock #11 first, so a dispute
 * and a decision of the administrator queue behind each other: the dispute either joins the open case or is
 * refused because the case is decided. A dispute freezes a project that is still `cooling`.
 */
@Injectable()
export class DisputeService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(FraudRepository) private readonly fraud: FraudRepository,
    @Inject(CreditRunService) private readonly runService: CreditRunService,
  ) {}

  create(userId: string, teamId: string, text: string): Promise<DisputeDto> {
    return this.tx.run(async () => {
      await this.locks.lockCreditRun(teamId);
      const run = await this.runs.find(teamId);
      const now = this.clock.now();
      if (run === undefined || !disputable(run, now)) throw invalidState();
      const created = await this.fraud.insertDispute(teamId, userId, text, now);
      if (created === undefined) throw invalidState();
      if (run.status === 'cooling') await this.runs.setState(teamId, { status: 'frozen' });
      await this.runService.openCase(teamId, now);
      return { id: created.id, teamId, createdAt: created.createdAt.toISOString() };
    });
  }
}
