import { DAY_MS } from './completion-rules.js';

/**
 * The record of a completed project (architecture 3.6 `CompletionSnapshot`, FR-WORK-13, FR-REW-15): what the
 * rewards read after the cooling. It is plain JSON (dates as ISO text) and is never changed after the insert.
 */
export interface CompletionSnapshot {
  teamId: string;
  completedAt: string;
  startedAt: string | null;
  plannedEndAt: string;
  overdueDays: number;
  productType: string;
  releaseUrl: string | null;
  repositoryId: number | null;
  roster: {
    members: {
      userId: string;
      isLead: boolean;
      joinedAt: string;
      joinedVia: string;
      roles: { roleCode: string; deficitAtJoin: boolean }[];
    }[];
    seats: {
      seatId: string;
      roleCode: string;
      desired: boolean;
      /** When the mark "желательная" last changed (AF-14); absent in records made before slice 7. */
      desiredChangedAt?: string | null;
      holderUserId: string | null;
    }[];
    departedUserIds: string[];
  };
  stages: { ordinal: number; stageKey: string; openedAt: string | null; closedAt: string | null }[];
  /** The roles are the labels at the moment of completion: they are locked in the same transaction. */
  contributions: {
    id: string;
    userId: string;
    roleCode: string;
    stageOrdinal: number | null;
    source: string;
    ref: string;
    receivedAt: string;
  }[];
  participationConfirms: { userId: string; stageOrdinal: number }[];
}

export interface SnapshotInput {
  teamId: string;
  completedAt: Date;
  startedAt: Date | null;
  plannedEndAt: Date;
  overdueDays: number;
  productType: string;
  releaseUrl: string | null;
  repositoryId: number | null;
  roster: {
    members: {
      userId: string;
      isLead: boolean;
      joinedAt: Date;
      joinedVia: string;
      roles: { roleCode: string; deficitAtJoin: boolean }[];
    }[];
    seats: {
      seatId: string;
      roleCode: string;
      desired: boolean;
      desiredChangedAt?: Date | null;
      holderUserId: string | null;
    }[];
    departedUserIds: string[];
  };
  stages: { ordinal: number; stageKey: string; openedAt: Date | null; closedAt: Date | null }[];
  contributions: {
    id: string;
    userId: string;
    roleCode: string;
    stageOrdinal: number | null;
    source: string;
    ref: string;
    receivedAt: Date;
  }[];
  participationConfirms: { userId: string; stageOrdinal: number }[];
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** The roster as it is recorded: members with their roles, the seats with `desired`, those who left. */
function rosterOf(roster: SnapshotInput['roster']): CompletionSnapshot['roster'] {
  return {
    members: [...roster.members]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map((m) => ({
        userId: m.userId,
        isLead: m.isLead,
        joinedAt: m.joinedAt.toISOString(),
        joinedVia: m.joinedVia,
        roles: m.roles.map((r) => ({ roleCode: r.roleCode, deficitAtJoin: r.deficitAtJoin })),
      })),
    seats: [...roster.seats]
      .sort((a, b) => a.seatId.localeCompare(b.seatId))
      .map((s) => ({
        seatId: s.seatId,
        roleCode: s.roleCode,
        desired: s.desired,
        desiredChangedAt: iso(s.desiredChangedAt ?? null),
        holderUserId: s.holderUserId,
      })),
    departedUserIds: [...roster.departedUserIds].sort(),
  };
}

/** Builds the snapshot; only the listed fields are kept and the lists come out in a fixed order. */
export function buildSnapshot(input: SnapshotInput): CompletionSnapshot {
  return {
    teamId: input.teamId,
    completedAt: input.completedAt.toISOString(),
    startedAt: iso(input.startedAt),
    plannedEndAt: input.plannedEndAt.toISOString(),
    overdueDays: input.overdueDays,
    productType: input.productType,
    releaseUrl: input.releaseUrl,
    repositoryId: input.repositoryId,
    roster: rosterOf(input.roster),
    stages: [...input.stages]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((s) => ({
        ordinal: s.ordinal,
        stageKey: s.stageKey,
        openedAt: iso(s.openedAt),
        closedAt: iso(s.closedAt),
      })),
    contributions: [...input.contributions]
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        userId: c.userId,
        roleCode: c.roleCode,
        stageOrdinal: c.stageOrdinal,
        source: c.source,
        ref: c.ref,
        receivedAt: c.receivedAt.toISOString(),
      })),
    participationConfirms: input.participationConfirms
      .map((c) => ({ userId: c.userId, stageOrdinal: c.stageOrdinal }))
      .sort((a, b) => a.stageOrdinal - b.stageOrdinal || a.userId.localeCompare(b.userId)),
  };
}

/** FR-REW-11: the credit is applied this long after the completion (C-17b). */
export const COOLING_MS = 7 * DAY_MS;

/** What the page of results shows from the stored snapshot (the contract's `Completion.snapshot`). */
export interface CompletionSnapshotView {
  members: {
    userId: string;
    isLead: boolean;
    roles: { roleCode: string; deficitAtJoin: boolean }[];
  }[];
  contributionByRole: { roleCode: string; count: number }[];
  stages: { ordinal: number; stageKey: string; openedAt: string | null; closedAt: string | null }[];
  overdueDays: number;
}

export function snapshotView(snapshot: CompletionSnapshot): CompletionSnapshotView {
  const counts = new Map<string, number>();
  for (const c of snapshot.contributions) counts.set(c.roleCode, (counts.get(c.roleCode) ?? 0) + 1);
  return {
    members: snapshot.roster.members.map((m) => ({
      userId: m.userId,
      isLead: m.isLead,
      roles: m.roles,
    })),
    contributionByRole: [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([roleCode, count]) => ({ roleCode, count })),
    stages: snapshot.stages,
    overdueDays: snapshot.overdueDays,
  };
}
