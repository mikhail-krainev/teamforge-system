/** A role the member holds in the team, with the time it was assigned (`seat_assignment.started_at`). */
export interface HeldRole {
  roleCode: string;
  assignedAt: Date;
}

const ROLE_LABEL = /^role:\s*([a-z0-9_-]+)$/i;

/**
 * The role a contribution of GitHub is credited to (architecture 7.6, FR-WORK-17): the label
 * `role:<code>` when the member holds that role in the team, otherwise the main role, the one held
 * the longest. A label of a role the member does not hold is ignored. `undefined`: no role at all.
 */
export function contributionRole(
  labels: readonly string[],
  held: readonly HeldRole[],
): string | undefined {
  const codes = new Set(held.map((role) => role.roleCode));
  for (const label of labels) {
    const code = ROLE_LABEL.exec(label.trim())?.[1]?.toLowerCase();
    if (code !== undefined && codes.has(code)) return code;
  }
  const main = [...held].sort(
    (a, b) =>
      a.assignedAt.getTime() - b.assignedAt.getTime() || a.roleCode.localeCompare(b.roleCode),
  )[0];
  return main?.roleCode;
}
