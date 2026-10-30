import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  type Page,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_API, type WorkspaceApi } from '../../../workspace/public.js';
import {
  type CaseKey,
  FraudRepository,
  type FraudCaseRow,
} from '../repositories/fraud.repository.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { CreditApplier } from '../services/credit-applier.service.js';
import { CreditRunService } from '../services/credit-run.service.js';
import { CreditService } from '../services/credit.service.js';
import { toFraudCaseDto } from './fraud-case-dto.js';

type FraudCaseDto = Ok<'getFraudCase'>;

export interface CaseQuery {
  status?: 'open' | 'ok' | 'violation';
  cursor?: string;
  limit?: number;
}

const notFound = (): DomainError => new DomainError('NOT_FOUND', 404);

/**
 * The queue of manual review and the decisions (S7-05, FR-REW-12, FR-REW-16, AF-25; architecture 10.4). A decision
 * takes lock #11 (`credit_run FOR UPDATE`) and then the row of the case, and looks at its status under them: of
 * ten decisions one wins and nine are 409 `INVALID_STATE`. `violation` revokes by `RETURNING`; `ok` returns the
 * project to the cooling (S7SEC-01, FR-REW-06, AF-22): its end credits it with the checks of the phase
 * `cooling_end`, at once when the cooling is over already. On a credited project `ok` does nothing.
 */
@Injectable()
export class FraudCaseService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
    @Inject(FraudRepository) private readonly fraud: FraudRepository,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(CreditApplier) private readonly applier: CreditApplier,
    @Inject(CreditRunService) private readonly runService: CreditRunService,
    @Inject(CreditService) private readonly credit: CreditService,
  ) {}

  async list(query: CaseQuery): Promise<Page<FraudCaseDto>> {
    const limit = clampLimit(query.limit);
    const filters = { status: query.status ?? null };
    const after =
      query.cursor === undefined ? undefined : caseKeyOf(decodeCursor(query.cursor, filters).k);
    return this.tx.run(async () => {
      const rows = await this.fraud.listCases(query.status, after, limit + 1);
      const page = buildPage(rows, limit, (r) => [r.openedAt.toISOString(), r.id], filters);
      return { items: await this.toDtos(page.items), nextCursor: page.nextCursor };
    });
  }

  async get(caseId: string): Promise<FraudCaseDto> {
    return this.tx.run(async () => {
      const row = await this.fraud.findCase(caseId);
      if (row === undefined) throw notFound();
      return (await this.toDtos([row]))[0] as FraudCaseDto;
    });
  }

  decide(
    adminId: string,
    caseId: string,
    decision: 'ok' | 'violation',
    comment: string,
  ): Promise<FraudCaseDto> {
    return this.tx.run(async () => {
      const found = await this.fraud.findCase(caseId);
      if (found === undefined) throw notFound();
      await this.assertNotOwnTeam(adminId, found.teamId);
      await this.locks.lockCreditRun(found.teamId);
      const locked = await this.fraud.lockCase(caseId);
      if (locked === undefined || locked.status !== 'open') {
        throw new DomainError('INVALID_STATE', 409);
      }
      const run = await this.runs.find(found.teamId);
      const now = this.clock.now();
      await this.fraud.decide(caseId, decision, adminId, comment, now);
      await this.fraud.insertAudit({
        actorUserId: adminId,
        action: `fraud_case_${decision}`,
        targetType: 'fraud_case',
        targetId: caseId,
        reason: comment,
        data: { teamId: found.teamId, runStatusBefore: run?.status ?? null },
        at: now,
      });
      if (run !== undefined) await this.settle(run, caseId, decision, now);
      const decided = await this.fraud.findCase(caseId);
      return (await this.toDtos([decided as FraudCaseRow]))[0] as FraudCaseDto;
    });
  }

  /**
   * S7SEC-03: the administrator is a user too; a case of a project he took part in (the roster of the completion,
   * the people who left before it, the live roster) is not his to decide: 403 `FORBIDDEN`. Reads through the
   * facades in the transaction of the decision.
   */
  private async assertNotOwnTeam(adminId: string, teamId: string): Promise<void> {
    const roster = await this.teams.getRoster(teamId);
    let involved = roster.some((m) => m.userId === adminId);
    if (!involved && (await this.workspace.getCompletion(teamId)) !== null) {
      const { members, departedUserIds } = (await this.workspace.getCompletionSnapshot(teamId))
        .roster;
      involved = members.some((m) => m.userId === adminId) || departedUserIds.includes(adminId);
    }
    if (involved) {
      throw new DomainError('FORBIDDEN', 403, {
        detail: 'A case of a project the administrator took part in is decided by another one',
      });
    }
  }

  /**
   * `violation` takes back what the project gave. `ok` never credits by itself (S7SEC-01): the project goes back to
   * `cooling`; before `cooling_until` a timer of its own credits it at the end, after it the credit of the phase
   * `cooling_end` runs now, in this transaction (AF-22 and the checks of fresh data; what the decision reviewed does
   * not freeze it again).
   */
  private async settle(
    run: CreditRunRow,
    caseId: string,
    decision: 'ok' | 'violation',
    now: Date,
  ): Promise<void> {
    if (decision === 'violation') {
      if (run.status !== 'revoked') await this.applier.revoke(run, now);
      return;
    }
    if (run.status !== 'cooling' && run.status !== 'frozen') return;
    await this.runs.setState(run.teamId, { status: 'cooling' });
    if (now.getTime() < run.coolingUntil.getTime()) {
      await this.runService.scheduleAfterReview(run.teamId, run.coolingUntil, caseId);
    } else {
      await this.credit.creditProject(run.teamId);
    }
  }

  /** The cases of a page with their signals, disputes and team names: four statements for any page size. */
  private async toDtos(rows: FraudCaseRow[]): Promise<FraudCaseDto[]> {
    const teamIds = [...new Set(rows.map((r) => r.teamId))];
    const [signals, disputes, names] = await Promise.all([
      this.fraud.signalsOf(teamIds),
      this.fraud.disputesOf(teamIds),
      this.teams.getTeamNames(teamIds),
    ]);
    return rows.map((row) =>
      toFraudCaseDto(row, {
        teamName: names.get(row.teamId) ?? '',
        signals: signals.filter((s) => s.teamId === row.teamId),
        disputes: disputes.filter((d) => d.teamId === row.teamId),
      }),
    );
  }
}

function caseKeyOf(key: (string | number | null)[]): CaseKey {
  const [openedAt, id] = key;
  if (typeof openedAt !== 'string' || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { openedAt: new Date(openedAt), id };
}
