import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { CompletionSnapshot } from '../../../workspace/public.js';
import type { AccountVerdict } from '../domain/credit-rules.js';
import { evaluateAll, summarizeAfterReview } from '../fraud/rules/index.js';
import type { Signal } from '../fraud/rules/facts.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { FraudRepository } from '../repositories/fraud.repository.js';
import { AccountVerdicts } from './account-verdicts.service.js';
import { CreditApplier } from './credit-applier.service.js';
import { CreditRunService, signalRows } from './credit-run.service.js';
import { FraudFactsService } from './fraud-facts.service.js';
import { SnapshotReader } from './snapshot-reader.service.js';

export type CreditOutcome = 'credited' | 'frozen' | 'skipped' | 'early';

/** What `creditProject` reads before its transaction (architecture 10.2): nothing here is locked. */
interface Inputs {
  snapshot: CompletionSnapshot;
  accounts: Map<string, AccountVerdict>;
  signals: Signal[];
}

const DUE_BATCH = 100;

/**
 * `creditProject(teamId)` (S7-04, CC-6, architecture 10.2): the job `rewards-cooling-end` at the end of the
 * cooling. The data of the snapshot and the checks of the accounts are read before `BEGIN`; the transaction takes
 * lock #11 (`credit_run FOR UPDATE`), looks at the status once more and writes. A repeated or parallel run finds
 * the run no longer `cooling` and leaves.
 */
@Injectable()
export class CreditService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(SnapshotReader) private readonly snapshots: SnapshotReader,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(FraudRepository) private readonly fraud: FraudRepository,
    @Inject(CreditApplier) private readonly applier: CreditApplier,
    @Inject(CreditRunService) private readonly runService: CreditRunService,
    @Inject(AccountVerdicts) private readonly verdicts: AccountVerdicts,
    @Inject(FraudFactsService) private readonly factsOf: FraudFactsService,
  ) {}

  async creditProject(teamId: string): Promise<CreditOutcome> {
    const run = await this.tx.run(() => this.runs.find(teamId));
    if (run === undefined || run.status !== 'cooling') return 'skipped';
    if (this.clock.now().getTime() < run.coolingUntil.getTime()) return 'early';
    const inputs = await this.readInputs(teamId, run);
    return this.tx.run(() => this.creditInTx(teamId, inputs));
  }

  /** The people of the snapshot, their account checks and the anti-fraud of the phase `cooling_end` (AF-22 among them). */
  private async readInputs(teamId: string, run: CreditRunRow): Promise<Inputs> {
    const snapshot = await this.snapshots.read(teamId);
    const facts = await this.factsOf.build(teamId, 'cooling_end', snapshot, run.rosterHash);
    const accounts = await this.verdicts.load(snapshot.roster.members.map((m) => m.userId));
    return { snapshot, accounts, signals: evaluateAll(facts) };
  }

  private async creditInTx(teamId: string, inputs: Inputs): Promise<CreditOutcome> {
    await this.locks.lockCreditRun(teamId);
    const run = await this.runs.find(teamId);
    if (run?.status !== 'cooling') return 'skipped';
    const now = this.clock.now();
    // S7SEC-01: a project the administrator found "ok" is frozen again only by what that decision has not seen.
    const reviewed = await this.fraud.reviewedRuleCodes(teamId);
    const summary = summarizeAfterReview(inputs.signals, reviewed);
    await this.fraud.insertSignals(teamId, signalRows(inputs.signals, 'cooling_end'), now);
    await this.runs.setState(teamId, { fraudScore: summary.score });
    if (summary.frozen) {
      await this.runs.setState(teamId, { status: 'frozen' });
      await this.runService.openCase(teamId, now);
      return 'frozen';
    }
    await this.applier.apply(run, inputs.snapshot, inputs.accounts, now);
    return 'credited';
  }

  /**
   * The CLI `run-job rewards-cooling-end` (the e2e stack and an operator): every run whose cooling is over goes
   * through the same path as its timer. One failing project does not stop the others.
   */
  async creditDue(): Promise<{ credited: number; frozen: number; failed: number }> {
    const report = { credited: 0, frozen: 0, failed: 0 };
    const seen = new Set<string>();
    for (;;) {
      const now = this.clock.now();
      const due = (await this.tx.run(() => this.runs.dueTeamIds(now, DUE_BATCH))).filter(
        (id) => !seen.has(id),
      );
      if (due.length === 0) return report;
      for (const teamId of due) {
        seen.add(teamId);
        await this.creditOne(teamId, report);
      }
    }
  }

  private async creditOne(
    teamId: string,
    report: { credited: number; frozen: number; failed: number },
  ): Promise<void> {
    try {
      const outcome = await this.creditProject(teamId);
      if (outcome === 'credited') report.credited += 1;
      if (outcome === 'frozen') report.frozen += 1;
    } catch (error) {
      report.failed += 1;
      this.logger.error({ err: error }, `credit of ${teamId} failed`);
    }
  }
}
