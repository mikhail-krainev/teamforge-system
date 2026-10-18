import { describe, expect, it } from 'vitest';
import { contributionRole, type HeldRole } from './contribution-role.js';

const at = (day: number): Date => new Date(Date.UTC(2026, 9, day));
const held: HeldRole[] = [
  { roleCode: 'frontend', assignedAt: at(5) },
  { roleCode: 'backend', assignedAt: at(2) },
];

describe('contributionRole (FR-WORK-17)', () => {
  it('takes the role named by a label when the member holds it', () => {
    expect(contributionRole(['bug', 'role:frontend'], held)).toBe('frontend');
    expect(contributionRole(['Role: Frontend'], held)).toBe('frontend');
  });

  it('ignores a label of a role the member does not hold', () => {
    expect(contributionRole(['role:designer'], held)).toBe('backend');
  });

  it('falls back to the role held the longest', () => {
    expect(contributionRole([], held)).toBe('backend');
  });

  it('has no role for a member without roles', () => {
    expect(contributionRole(['role:backend'], [])).toBeUndefined();
  });
});
