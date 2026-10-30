import { Inject, Injectable } from '@nestjs/common';
import { InlineDelivery } from '../../../../platform/outbox/inline-delivery.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { NewOutboxEvent } from '../../../../platform/outbox/outbox.types.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import type { CompletionSnapshot } from '../../../workspace/public.js';
import { individualBadges, seriesStepsLost, teamBonusRecipients } from '../domain/award-rules.js';
import { BADGE } from '../domain/constants.js';
import { type AccountVerdict, decideMembers } from '../domain/credit-rules.js';
import {
  type AwardedBadge,
  AwardRepository,
  type NewAward,
} from '../repositories/award.repository.js';
import {
  type CounterDelta,
  CounterRepository,
  type CounterValue,
} from '../repositories/counter.repository.js';
import { CreditRepository, type ChangedRole } from '../repositories/credit.repository.js';
import { CreditRunRepository, type CreditRunRow } from '../repositories/credit-run.repository.js';
import { REWARDS_MODULE, type CreditsChangedPayload } from '../../public.js';

/** What was credited now: the people whose total counter goes up and the roles whose counters do. */
interface Credited {
  users: string[];
  roles: ChangedRole[];
}

/** Revocation reason of the awards of a project (FR-REW-12). */
export const REVOKE_REASON = 'violation';

/**
 * The writes of the credit, always under lock #11 of the run (architecture 10.2, 10.4): rows by `ON CONFLICT DO
 * NOTHING RETURNING`, counters and awards only for what was really inserted or changed, one event per person.
 * The caller holds the lock and has checked the status of the run.
 */
@Injectable()
export class CreditApplier {
  constructor(
    @Inject(CreditRepository) private readonly credits: CreditRepository,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(CounterRepository) private readonly counters: CounterRepository,
    @Inject(AwardRepository) private readonly awards: AwardRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(InlineDelivery) private readonly inline: InlineDelivery,
    @Inject(AUTH_API) private readonly auth: AuthApi,
  ) {}

  /**
   * The snapshot of the completion is immutable and still names a person who asked for the deletion of the account
   * during the cooling. Rows of such a person would bring back what the deletion saga removed (152-FZ), so the
   * credit sees only the members whose account is `active` now. Read inside the transaction, under lock #11.
   */
  private async activeOnly(snapshot: CompletionSnapshot): Promise<CompletionSnapshot> {
    const active = await this.auth.filterActive(snapshot.roster.members.map((m) => m.userId));
    return {
      ...snapshot,
      roster: {
        ...snapshot.roster,
        members: snapshot.roster.members.filter((m) => active.has(m.userId)),
      },
    };
  }

  /** The credit of the project (FR-REW-01..10): the run becomes `credited`. Returns the people credited now. */
  async apply(
    run: CreditRunRow,
    full: CompletionSnapshot,
    accounts: ReadonlyMap<string, AccountVerdict>,
    now: Date,
  ): Promise<number> {
    const snapshot = await this.activeOnly(full);
    const decisions = decideMembers(snapshot, accounts);
    const inserted = await this.credits.insertProjectCredits(
      decisions.map((d) => ({
        teamId: run.teamId,
        userId: d.userId,
        status: d.status,
        reason: d.reason,
        productTypeCode: snapshot.productType,
        overdueDays: snapshot.overdueDays,
        completedAt: run.completedAt,
        rosterHash: run.rosterHash,
        decidedAt: now,
      })),
    );
    const roles = await this.credits.insertCredits(
      decisions
        .filter((d) => inserted.has(d.userId))
        .flatMap((d) =>
          d.roles.map((r) => ({
            teamId: run.teamId,
            userId: d.userId,
            roleCode: r.roleCode,
            status: d.status,
            deficitAtJoin: r.deficitAtJoin,
            creditedAt: d.status === 'credited' ? now : null,
          })),
        ),
    );
    const users = decisions
      .filter((d) => inserted.has(d.userId) && d.status === 'credited')
      .map((d) => d.userId);
    await this.settle(run, snapshot, now, {
      users,
      roles: roles.filter((r) => r.status === 'credited'),
    });
    await this.runs.setState(run.teamId, { status: 'credited', creditedAt: now });
    return users.length;
  }

  /** FR-GH-09: people whose account has grown up move from `pending_account` to `credited` (a run that is `credited`). */
  async promote(
    run: CreditRunRow,
    full: CompletionSnapshot,
    userIds: string[],
    now: Date,
  ): Promise<number> {
    const snapshot = await this.activeOnly(full);
    const staying = new Set(snapshot.roster.members.map((m) => m.userId));
    const roles = await this.credits.promote(
      run.teamId,
      userIds.filter((id) => staying.has(id)),
      now,
    );
    const users = [...new Set(roles.map((r) => r.userId))];
    if (users.length > 0) await this.settle(run, snapshot, now, { users, roles });
    return users.length;
  }

  /** FR-REW-12: the credit, the counters and the awards of the project are taken back, by what `RETURNING` changed. */
  async revoke(run: CreditRunRow, now: Date): Promise<number> {
    const { users, roles } = await this.credits.revokeRun(run.teamId);
    const deltas: CounterDelta[] = [
      ...users.map((userId) => ({ userId, roleCode: null, delta: 1 })),
      ...roles.map((r) => ({ userId: r.userId, roleCode: r.roleCode, delta: 1 })),
    ];
    const values = await this.counters.decrease(deltas);
    const revoked = [
      ...(await this.awards.revokeOfTeam(run.teamId, REVOKE_REASON, now)),
      ...(await this.revokeLostSteps([...users, ...roles.map((r) => r.userId)], now)),
    ];
    await this.runs.setState(run.teamId, { status: 'revoked' });
    await this.publishChanged(users.map((userId) => creditsChanged(userId, values)));
    await this.outbox.publishMany(
      revoked.map((a) => ({
        module: REWARDS_MODULE,
        type: 'award_revoked',
        aggregateId: run.teamId,
        payload: { userId: a.userId, badgeCode: a.badgeCode, teamId: a.teamId ?? run.teamId },
      })),
    );
    return users.length;
  }

  /**
   * M-4: the steps of a series granted by another project of the person fall with the counts: after the rows of the
   * project are revoked, the stats are read again and a step no longer reached is revoked, so the badges agree with
   * the counters.
   */
  private async revokeLostSteps(userIds: string[], now: Date): Promise<AwardedBadge[]> {
    const stats = await this.credits.stats([...new Set(userIds)]);
    const lost = [...stats].map(([userId, s]) => ({ userId, codes: seriesStepsLost(s) }));
    return this.awards.revokeCodesOf(lost, REVOKE_REASON, now);
  }

  /** Counters up, then the awards computed from the rows that exist now, then the events. */
  private async settle(
    run: CreditRunRow,
    snapshot: CompletionSnapshot,
    now: Date,
    credited: Credited,
  ): Promise<void> {
    const values = await this.counters.increase([
      ...credited.users.map((userId) => ({ userId, roleCode: null, delta: 1 })),
      ...credited.roles.map((r) => ({ userId: r.userId, roleCode: r.roleCode, delta: 1 })),
    ]);
    const creditedRoles = await this.credits.creditedRolesOfTeam(run.teamId);
    const rows = await this.awardRows(run.teamId, snapshot, now, credited.users, creditedRoles);
    const granted = await this.awards.insertMany(rows);
    await this.publishChanged(credited.users.map((userId) => creditsChanged(userId, values)));
    await this.outbox.publishMany(
      granted.map((a) => ({
        module: REWARDS_MODULE,
        type: 'award_granted',
        aggregateId: run.teamId,
        payload: { userId: a.userId, badgeCode: a.badgeCode, teamId: run.teamId },
      })),
    );
  }

  /**
   * `credits_changed` is delivered to its consumers (matching: `candidate_stats`) in the same transaction, so the
   * next reader of the credit sees the counters of matching too; the relay delivers it again and the inbox skips it.
   */
  private async publishChanged(events: NewOutboxEvent[]): Promise<void> {
    await this.inline.deliver(await this.outbox.publishMany(events));
  }

  /** The individual badges of the people credited now and the team badge of the project (architecture 10.3). */
  private async awardRows(
    teamId: string,
    snapshot: CompletionSnapshot,
    now: Date,
    users: string[],
    creditedRoles: ChangedRole[],
  ): Promise<NewAward[]> {
    const available = await this.awards.availableCodes();
    const stats = await this.credits.stats(users);
    const rows: NewAward[] = [];
    for (const userId of users) {
      const userStats = stats.get(userId);
      if (userStats === undefined) continue;
      const closedDeficit = creditedRoles.some((r) => r.userId === userId && r.deficitAtJoin);
      for (const badgeCode of individualBadges(userStats, {
        overdueDays: snapshot.overdueDays,
        closedDeficit,
      })) {
        if (available.has(badgeCode)) {
          rows.push({ userId, badgeCode, scope: 'individual', teamId, awardedAt: now });
        }
      }
    }
    for (const userId of teamBonusRecipients(snapshot, creditedRoles)) {
      rows.push({ userId, badgeCode: BADGE.vacancy, scope: 'team', teamId, awardedAt: now });
    }
    return rows;
  }
}

/** One `rewards.credits_changed` of a person: the counters of the roles that changed, after the change. */
function creditsChanged(userId: string, values: CounterValue[]): NewOutboxEvent {
  const own = values.filter((v) => v.userId === userId);
  const perRole = own.filter((v) => v.roleCode !== null);
  const payload: CreditsChangedPayload = {
    v: 1,
    userId,
    roleCodes: perRole.map((v) => v.roleCode as string),
    counters: Object.fromEntries(perRole.map((v) => [v.roleCode as string, v.value])),
    total: own.find((v) => v.roleCode === null)?.value ?? 0,
  };
  return {
    module: REWARDS_MODULE,
    type: 'credits_changed',
    aggregateId: userId,
    payload: { ...payload },
  };
}
