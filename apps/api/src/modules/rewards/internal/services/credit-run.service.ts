import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import {
  type CompletionSnapshot,
  WORKSPACE_API,
  type WorkspaceApi,
} from '../../../workspace/public.js';
import { REWARDS_MODULE } from '../../public.js';
import { COOLING_MS } from '../domain/constants.js';
import { evaluateAll, summarize } from '../fraud/rules/index.js';
import type { Phase, Signal } from '../fraud/rules/facts.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { FraudRepository, type NewSignal } from '../repositories/fraud.repository.js';
import { FraudFactsService } from './fraud-facts.service.js';

export const COOLING_END_JOB = 'rewards-cooling-end';

/** AF-13: SHA-256 of the sorted user ids of the team at the completion. */
export function rosterHashOf(snapshot: CompletionSnapshot): Buffer {
  const ids = snapshot.roster.members.map((m) => m.userId).sort();
  return createHash('sha256').update(ids.join(',')).digest();
}

/** The rows of a phase as the table keeps them. */
export function signalRows(signals: Signal[], phase: Phase): NewSignal[] {
  return signals.map((s) => ({ ...s, phase }));
}

/**
 * The credit run of a completed project (architecture 10.1): opened by `workspace.project_completed` and by the
 * scanner `credit-run-scan` with the same code. `INSERT ... ON CONFLICT DO NOTHING` makes the two safe to run at
 * once: the loser changes nothing and schedules nothing.
 */
@Injectable()
export class CreditRunService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(FraudRepository) private readonly fraud: FraudRepository,
    @Inject(FraudFactsService) private readonly factsOf: FraudFactsService,
  ) {}

  /** Runs inside the caller's transaction. Returns true when this call opened the run. */
  async open(teamId: string): Promise<boolean> {
    if ((await this.runs.find(teamId)) !== undefined) return false;
    const snapshot = await this.workspace.getCompletionSnapshot(teamId);
    const rosterHash = rosterHashOf(snapshot);
    const signals = evaluateAll(
      await this.factsOf.build(teamId, 'completion', snapshot, rosterHash),
    );
    const summary = summarize(signals);
    const completedAt = new Date(snapshot.completedAt);
    const created = await this.runs.insert({
      teamId,
      completedAt,
      coolingUntil: new Date(completedAt.getTime() + COOLING_MS),
      status: summary.frozen ? 'frozen' : 'cooling',
      rosterHash,
      fraudScore: summary.score,
    });
    if (!created) return false;
    const now = this.clock.now();
    await this.fraud.insertSignals(teamId, signalRows(signals, 'completion'), now);
    if (summary.frozen) await this.openCase(teamId, now);
    else await this.scheduleCooling(teamId, completedAt);
    return true;
  }

  /** FR-REW-15: a frozen project goes to the queue of the administrator; one open case per team. */
  async openCase(teamId: string, now: Date): Promise<void> {
    const caseId = await this.fraud.openCase(teamId, now);
    if (caseId === undefined) return;
    await this.outbox.publish({
      module: REWARDS_MODULE,
      type: 'case_opened',
      aggregateId: caseId,
      payload: { teamId, caseId },
    });
  }

  /** The timer of the end of the cooling; the id is deterministic, so a second add is a no-op (CC-6). */
  private async scheduleCooling(teamId: string, completedAt: Date): Promise<void> {
    await this.addCoolingEnd(teamId, completedAt.getTime() + COOLING_MS, jobId('credit', teamId));
  }

  /**
   * S7SEC-01: the decision `ok` of a case returns the project to the cooling, and its end credits it. The timer of
   * the completion may have run already (it left the frozen project alone) and BullMQ keeps a completed job for a
   * day, so an add under its id could be a no-op: the timer of a decision has an id of its own. Should both run,
   * the second finds the project credited (CC-6).
   */
  async scheduleAfterReview(teamId: string, coolingUntil: Date, caseId: string): Promise<void> {
    await this.addCoolingEnd(teamId, coolingUntil.getTime(), jobId('credit', teamId, caseId));
  }

  private async addCoolingEnd(teamId: string, dueAt: number, id: string): Promise<void> {
    await this.queues.add(
      'timers',
      COOLING_END_JOB,
      { teamId },
      { jobId: id, delayMs: Math.max(0, dueAt - this.clock.now().getTime()) },
    );
  }

  /** The state of a run as the callers read it. */
  find(teamId: string): Promise<CreditRunRow | undefined> {
    return this.runs.find(teamId);
  }
}
