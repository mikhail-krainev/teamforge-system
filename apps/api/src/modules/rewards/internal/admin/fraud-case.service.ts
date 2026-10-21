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
import type { CompletionSnapshot } from '../../../workspace/public.js';
import type { AccountVerdict } from '../domain/credit-rules.js';
import {
  type CaseKey,
  FraudRepository,
  type FraudCaseRow,
} from '../repositories/fraud.repository.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { AccountVerdicts } from '../services/account-verdicts.service.js';
import { CreditApplier } from '../services/credit-applier.service.js';
import { SnapshotReader } from '../services/snapshot-reader.service.js';
import { toFraudCaseDto } from './fraud-case-dto.js';

type FraudCaseDto = Ok<'getFraudCase'>;

export interface CaseQuery {
  status?: 'open' | 'ok' | 'violation';
  cursor?: string;
  limit?: number;
}

/** What a decision `ok` needs to credit the project, read inside the transaction before lock #11 is taken. */
interface CreditInputs {
  snapshot: CompletionSnapshot;
  accounts: Map<string, AccountVerdict>;
}

const notFound = (): DomainError => new DomainError('NOT_FOUND', 404);

/**
 * The queue of manual review and the decisions (S7-05, FR-REW-12, FR-REW-16, AF-25; architecture 10.4). A decision
 * takes lock #11 (`credit_run FOR UPDATE`) and then the row of the case, and looks at its status under them: of
 * ten decisions one wins and nine are 409 `INVALID_STATE`. `violation` revokes by `RETURNING`; `ok` credits as
 * the cooling timer does (or does nothing when the project is credited already).
 */
@Injectable()
export class FraudCaseService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(SnapshotReader) private readonly snapshots: SnapshotReader,
    @Inject(FraudRepository) private readonly fraud: FraudRepository,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(CreditApplier) private readonly applier: CreditApplier,
    @Inject(AccountVerdicts) private readonly verdicts: AccountVerdicts,
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
      const inputs = decision === 'ok' ? await this.creditInputs(found.teamId) : undefined;
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
      if (run !== undefined) await this.settle(run, decision, inputs, now);
      const decided = await this.fraud.findCase(caseId);
      return (await this.toDtos([decided as FraudCaseRow]))[0] as FraudCaseDto;
    });
  }

  /** `ok` credits a project that has not been credited yet; `violation` takes back what the project gave. */
  private async settle(
    run: CreditRunRow,
    decision: 'ok' | 'violation',
    inputs: CreditInputs | undefined,
    now: Date,
  ): Promise<void> {
    if (decision === 'violation') {
      if (run.status !== 'revoked') await this.applier.revoke(run, now);
      return;
    }
    if ((run.status === 'cooling' || run.status === 'frozen') && inputs !== undefined) {
      await this.applier.apply(run, inputs.snapshot, inputs.accounts, now);
    }
  }

  /** Snapshot and account checks, only for a project that is not credited yet (nothing is locked here). */
  private async creditInputs(teamId: string): Promise<CreditInputs | undefined> {
    const run = await this.runs.find(teamId);
    if (run?.status !== 'cooling' && run?.status !== 'frozen') return undefined;
    const snapshot = await this.snapshots.read(teamId);
    const accounts = await this.verdicts.load(snapshot.roster.members.map((m) => m.userId));
    return { snapshot, accounts };
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
