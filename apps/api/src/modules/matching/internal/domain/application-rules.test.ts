import { describe, expect, it } from 'vitest';
import { diffRoles, roleErrors, type StoredRole } from './application-rules.js';

const at = new Date('2026-10-16T10:00:00Z');
const stored = (roleCode: string, priority: number): StoredRole => ({
  roleCode,
  priority,
  addedAt: at,
});

describe('roleErrors', () => {
  it('accepts distinct roles with distinct priorities', () => {
    expect(
      roleErrors([
        { roleCode: 'backend', priority: 1 },
        { roleCode: 'qa', priority: 2 },
      ]),
    ).toEqual([]);
  });

  it('points at a repeated role and a repeated priority', () => {
    const errors = roleErrors([
      { roleCode: 'backend', priority: 1 },
      { roleCode: 'backend', priority: 2 },
      { roleCode: 'qa', priority: 2 },
    ]);
    expect(errors.map((e) => [e.pointer, e.code])).toEqual([
      ['/roles/1/roleCode', 'duplicate_role'],
      ['/roles/2/priority', 'duplicate_priority'],
    ]);
  });
});

describe('diffRoles', () => {
  it('reports no change for an identical set, in any order', () => {
    const change = diffRoles(
      [stored('backend', 1), stored('qa', 2)],
      [
        { roleCode: 'qa', priority: 2 },
        { roleCode: 'backend', priority: 1 },
      ],
    );
    expect(change.changed).toBe(false);
  });

  it('treats a priority swap as two reprioritized roles and nothing added or removed', () => {
    const change = diffRoles(
      [stored('backend', 1), stored('qa', 2)],
      [
        { roleCode: 'backend', priority: 2 },
        { roleCode: 'qa', priority: 1 },
      ],
    );
    expect(change).toMatchObject({ removed: [], added: [], changed: true });
    expect(change.reprioritized).toHaveLength(2);
  });

  it('separates removed and added roles', () => {
    const change = diffRoles(
      [stored('backend', 1), stored('qa', 2)],
      [
        { roleCode: 'backend', priority: 1 },
        { roleCode: 'devops', priority: 2 },
      ],
    );
    expect(change.removed).toEqual(['qa']);
    expect(change.added).toEqual([{ roleCode: 'devops', priority: 2 }]);
    expect(change.reprioritized).toEqual([]);
  });
});
