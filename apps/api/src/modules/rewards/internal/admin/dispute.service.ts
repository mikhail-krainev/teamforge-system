import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { assertPlainText } from '../../../../platform/errors/plain-text.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { WORKSPACE_API, type WorkspaceApi } from '../../../workspace/public.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { FraudRepository } from '../repositories/fraud.repository.js';
import { CreditRunService } from '../services/credit-run.service.js';

type DisputeDto = Ok<'createDispute'>;

/** Length of a dispute text (contract `DisputeCreate.text`). */
const DISPUTE_TEXT_LIMITS = { min: 20, max: 4000 } as const;

const invalidState = (): DomainError => new DomainError('INVALID_STATE', 409);

/**
 * FR-REW-11: a project can be disputed in the cooling and while its case is open. A decision `ok` returns the project
 * to the cooling (S7SEC-01), so the window of the others stays open until `cooling_until`; each person disputes once.
 */
function disputable(run: CreditRunRow, now: Date): boolean {
  if (run.status === 'frozen') return true;
  return run.status === 'cooling' && now.getTime() < run.coolingUntil.getTime();
}

/**
 * `createDispute` (S7-05, FR-REW-11, CC-12): a member of the roster at the completion disputes the project once. Lock #11 first, so a dispute
 * and a decision of the administrator queue behind each other: the dispute either joins the open case or is
 * refused because the case is decided. A dispute freezes a project that is still `cooling`.
 */
@Injectable()
export class DisputeService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(FraudRepository) private readonly fraud: FraudRepository,
    @Inject(CreditRunService) private readonly runService: CreditRunService,
  ) {}

  create(userId: string, teamId: string, text: string): Promise<DisputeDto> {
    assertPlainText(text, DISPUTE_TEXT_LIMITS, '/text');
    return this.tx.run(async () => {
      await this.locks.lockCreditRun(teamId);
      const run = await this.runs.find(teamId);
      const now = this.clock.now();
      if (run === undefined || !disputable(run, now)) throw invalidState();
      await this.assertMemberAtCompletion(teamId, userId);
      const created = await this.fraud.insertDispute(teamId, userId, text, now);
      if (created === undefined) throw invalidState();
      if (run.status === 'cooling') await this.runs.setState(teamId, { status: 'frozen' });
      await this.runService.openCase(teamId, now);
      return { id: created.id, teamId, createdAt: created.createdAt.toISOString() };
    });
  }

  /**
   * S7SEC-07: only a member of the roster at the completion disputes; a person who left or was excluded before it
   * passes `team-participant` but would freeze the credit of the others: 404, as for a stranger.
   */
  private async assertMemberAtCompletion(teamId: string, userId: string): Promise<void> {
    const snapshot = await this.workspace.getCompletionSnapshot(teamId);
    if (!snapshot.roster.members.some((m) => m.userId === userId)) {
      throw new DomainError('NOT_FOUND', 404);
    }
  }
}
