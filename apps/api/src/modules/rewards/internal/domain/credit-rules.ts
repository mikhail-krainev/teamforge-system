import type { CompletionSnapshot } from '../../../workspace/public.js';
import { type ItemStatus, REASON, STAGE_SHARE_PERCENT } from './constants.js';

/** What github knows of the account of a person (FR-GH-09): `unknown` until it was checked. */
export interface AccountVerdict {
  status: 'eligible' | 'pending_account' | 'unknown';
  reasons: string[];
}

export interface RoleCredit {
  roleCode: string;
  deficitAtJoin: boolean;
}

export interface MemberDecision {
  userId: string;
  status: Exclude<ItemStatus, 'revoked'>;
  reason: string | null;
  /** The roles that get a `credit` row: the ones with a contribution (FR-REW-02), or every held role when denied for none. */
  roles: RoleCredit[];
}

type Member = CompletionSnapshot['roster']['members'][number];

/** C-60: `ceil(60 % of the stages)` in integers (0.6 * 5 is not exactly 3 in floating point). */
export function stagesNeeded(totalStages: number): number {
  return Math.floor((totalStages * STAGE_SHARE_PERCENT + 99) / 100);
}

/**
 * FR-REW-01 (3): a stage counts for a person when he was in the team in its window (joined before it closed) and
 * has a contribution of that stage or the lead confirmed his participation (FR-WORK-11).
 */
export function stagesTakenPart(snapshot: CompletionSnapshot, member: Member): number {
  const joined = Date.parse(member.joinedAt);
  const contributed = new Set(
    snapshot.contributions
      .filter((c) => c.userId === member.userId && c.stageOrdinal !== null)
      .map((c) => c.stageOrdinal),
  );
  const confirmed = new Set(
    snapshot.participationConfirms
      .filter((c) => c.userId === member.userId)
      .map((c) => c.stageOrdinal),
  );
  return snapshot.stages.filter((stage) => {
    const end = Date.parse(stage.closedAt ?? snapshot.completedAt);
    return joined <= end && (contributed.has(stage.ordinal) || confirmed.has(stage.ordinal));
  }).length;
}

/** The roles under which the person has a contribution (FR-REW-02, FR-REW-03), ordered by code. */
function contributionRoles(snapshot: CompletionSnapshot, member: Member): RoleCredit[] {
  const seen = new Set<string>();
  const roles: RoleCredit[] = [];
  for (const c of snapshot.contributions) {
    if (c.userId !== member.userId || seen.has(c.roleCode)) continue;
    seen.add(c.roleCode);
    const held = member.roles.find((r) => r.roleCode === c.roleCode);
    roles.push({ roleCode: c.roleCode, deficitAtJoin: held?.deficitAtJoin ?? false });
  }
  return roles.sort((a, b) => a.roleCode.localeCompare(b.roleCode));
}

function denied(member: Member, reason: string, roles: RoleCredit[]): MemberDecision {
  const shown = roles.length > 0 ? roles : member.roles;
  return { userId: member.userId, status: 'denied', reason, roles: shown.map((r) => ({ ...r })) };
}

/** The verdict of the conditions (1)-(3) and (5) of FR-REW-01 for one member of the completion. */
export function decideMember(
  snapshot: CompletionSnapshot,
  member: Member,
  account: AccountVerdict | undefined,
): MemberDecision {
  const roles = contributionRoles(snapshot, member);
  if (roles.length === 0) return denied(member, REASON.noContribution, []);
  if (stagesTakenPart(snapshot, member) < stagesNeeded(snapshot.stages.length)) {
    return denied(member, REASON.tooFewStages, roles);
  }
  if (account?.status === 'eligible') {
    return { userId: member.userId, status: 'credited', reason: null, roles };
  }
  const reason = account?.reasons[0] ?? REASON.accountNotChecked;
  return { userId: member.userId, status: 'pending_account', reason, roles };
}

/** Every person active at the completion (an early leaver is not in the snapshot roster) is decided. */
export function decideMembers(
  snapshot: CompletionSnapshot,
  accounts: ReadonlyMap<string, AccountVerdict>,
): MemberDecision[] {
  return snapshot.roster.members.map((m) => decideMember(snapshot, m, accounts.get(m.userId)));
}
