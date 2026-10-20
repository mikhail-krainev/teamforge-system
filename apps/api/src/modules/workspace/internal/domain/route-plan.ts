/** Pure rules of the project route (FR-WORK-01, -02, -12, -18): no I/O, so they are unit-tested directly. */

const DAY_MS = 86_400_000;

/** An active member and the roles he holds; the lead without a seat role has none. */
export interface RoleHolder {
  userId: string;
  roles: readonly string[];
}

export interface StepRoles {
  /** A role code or `any`. */
  ownerRole: string;
  altRoles: readonly string[];
}

/** Who carries a step when the project starts (architecture 11.2). */
export interface ExecutorChoice {
  assigneeUserId: string | null;
  roleCode: string | null;
  fallbackUsed: boolean;
}

const NOBODY: ExecutorChoice = { assigneeUserId: null, roleCode: null, fallbackUsed: false };

function holdersOf(members: readonly RoleHolder[], roles: readonly string[]): RoleHolder[] {
  return members.filter((m) => m.roles.some((r) => roles.includes(r)));
}

/**
 * FR-WORK-02: `any` has no executor; one holder of the owner role is the executor; several holders
 * wait for the lead; without an owner role the alternative roles decide in the same way; with
 * none of them the step goes to the fallback and waits for the lead.
 */
export function chooseExecutor(step: StepRoles, members: readonly RoleHolder[]): ExecutorChoice {
  if (step.ownerRole === 'any') return NOBODY;
  const owners = holdersOf(members, [step.ownerRole]);
  const [onlyOwner] = owners;
  if (owners.length === 1 && onlyOwner !== undefined) {
    return { assigneeUserId: onlyOwner.userId, roleCode: step.ownerRole, fallbackUsed: false };
  }
  if (owners.length > 1) return NOBODY;
  const alternatives = holdersOf(members, step.altRoles);
  const [onlyAlternative] = alternatives;
  if (alternatives.length === 1 && onlyAlternative !== undefined) {
    const role = step.altRoles.find((r) => onlyAlternative.roles.includes(r)) ?? null;
    return { assigneeUserId: onlyAlternative.userId, roleCode: role, fallbackUsed: false };
  }
  if (alternatives.length > 1) return NOBODY;
  return { assigneeUserId: null, roleCode: null, fallbackUsed: true };
}

/** Due date of a stage opened at `openedAt` (FR-WORK-12). */
export function stageDueAt(openedAt: Date, durationDays: number): Date {
  return new Date(openedAt.getTime() + durationDays * DAY_MS);
}

export interface StageTimes {
  status: string;
  dueAt: Date | null;
  closedAt: Date | null;
}

/**
 * Time the team has been suspended right now (FR-WORK-18): the timers of the stages are frozen, so
 * the open stage gets the same extension as the project. Zero while the team works.
 */
export function ongoingSuspensionMs(
  team: { status: string; suspendedAt: Date | null },
  now: Date,
): number {
  if (team.status !== 'suspended' || team.suspendedAt === null) return 0;
  return Math.max(0, now.getTime() - team.suspendedAt.getTime());
}

/**
 * How far the due date stored for an open stage is behind the clock of the team (FR-WORK-18): the
 * finished suspensions its date does not contain yet (`applied` is the part it does) and the one
 * running now. The stored date catches up when the status change is processed (`due_at` shift).
 */
export function stageSuspensionMs(
  team: { status: string; suspendedAt: Date | null; suspendedTotalSeconds: number },
  appliedSeconds: number,
  now: Date,
): number {
  const pendingSeconds = Math.max(0, team.suspendedTotalSeconds - appliedSeconds);
  return pendingSeconds * 1000 + ongoingSuspensionMs(team, now);
}

/** Due date shown for a stage: the open stage is moved by the current suspension. */
export function effectiveDueAt(stage: StageTimes, suspensionMs: number): Date | null {
  if (stage.dueAt === null) return null;
  return stage.status === 'open' ? new Date(stage.dueAt.getTime() + suspensionMs) : stage.dueAt;
}

/**
 * Lateness is a warning only (FR-WORK-12). The open stage is late after its due date or when the
 * whole project is past its planned end; a closed stage is late when it was closed after the due date.
 */
export function isOverdue(
  stage: StageTimes,
  due: Date | null,
  plannedEndAt: Date | null,
  now: Date,
): boolean {
  if (stage.status === 'open') {
    const pastDue = due !== null && now.getTime() > due.getTime();
    const pastProject = plannedEndAt !== null && now.getTime() > plannedEndAt.getTime();
    return pastDue || pastProject;
  }
  if (stage.status === 'closed') {
    return due !== null && stage.closedAt !== null && stage.closedAt.getTime() > due.getTime();
  }
  return false;
}
