import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import type {
  AwardView,
  CounterView,
  CreditItemStatus,
  CreditRunStatus,
  CreditStatusView,
} from '../../public.js';
import { AwardRepository, type BadgeRow } from '../repositories/award.repository.js';
import { CounterRepository } from '../repositories/counter.repository.js';
import { CreditRepository } from '../repositories/credit.repository.js';
import { CreditRunRepository } from '../repositories/credit-run.repository.js';

type Series = AwardView['series'];

/**
 * The reads of rewards (S7-06, FR-REW-04, FR-REW-05, FR-REW-14): the catalog, the awards and counters of a person
 * (public for signed-in users, nothing of the anti-fraud in them) and the credit of a project as a participant sees
 * it. Plain indexed queries; a credit or a revocation shows at once because nothing is cached.
 */
@Injectable()
export class RewardsReadService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(AwardRepository) private readonly awards: AwardRepository,
    @Inject(CounterRepository) private readonly counters: CounterRepository,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
  ) {}

  catalog(): Promise<BadgeRow[]> {
    return this.tx.run(() => this.awards.catalog());
  }

  /** The active awards of a person; an unknown or deleted person is 404 (HTTP callers), `null`-free for the facade. */
  async awardsOf(userId: string): Promise<AwardView[]> {
    return this.tx.run(async () => {
      const rows = await this.awards.listActive(userId);
      const teamIds = [...new Set(rows.flatMap((r) => (r.teamId === null ? [] : [r.teamId])))];
      const names = await this.teams.getTeamNames(teamIds);
      return rows.map((r) => ({
        badgeCode: r.badgeCode,
        name: r.name,
        series: r.series as Series,
        step: r.step,
        teamId: r.teamId,
        teamName: r.teamId === null ? null : (names.get(r.teamId) ?? null),
        awardedAt: r.awardedAt,
      }));
    });
  }

  async countersOf(userId: string): Promise<CounterView> {
    return this.tx.run(async () => {
      const [rows, productTypes] = await Promise.all([
        this.counters.listOf([userId]),
        this.counters.productTypes(userId),
      ]);
      const total = rows.find((r) => r.roleCode === null)?.value ?? 0;
      const byRole = rows.flatMap((r) =>
        r.roleCode === null ? [] : [{ roleCode: r.roleCode, value: r.value }],
      );
      return { total, byRole, productTypes: total === 0 ? [] : productTypes };
    });
  }

  /** `null` when the project has no credit run; the caller has checked that the person is a participant. */
  async creditOf(teamId: string, userId: string): Promise<CreditStatusView | null> {
    return this.tx.run(async () => {
      const run = await this.runs.find(teamId);
      if (run === undefined) return null;
      const mine = await this.credits.myCredits(teamId, userId);
      return {
        teamId,
        status: run.status as CreditRunStatus,
        coolingUntil: run.coolingUntil,
        myCredits: mine.map((c) => ({
          roleCode: c.roleCode,
          status: c.status as CreditItemStatus,
          reason: c.reason,
        })),
      };
    });
  }

  /** 404 for a person that does not exist (or is deleted): the same answer as for any unknown id. */
  async assertUserExists(userId: string): Promise<void> {
    const identity = await this.auth.getIdentity(userId);
    if (identity === null || identity.status === 'deleted') throw new DomainError('NOT_FOUND', 404);
  }
}
