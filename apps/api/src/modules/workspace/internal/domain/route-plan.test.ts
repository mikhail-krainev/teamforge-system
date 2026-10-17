import { describe, expect, it } from 'vitest';
import {
  chooseExecutor,
  effectiveDueAt,
  isOverdue,
  ongoingSuspensionMs,
  stageDueAt,
} from './route-plan.js';

const DAY = 86_400_000;
const lead = { userId: 'lead', roles: [] as string[] };
const backend = { userId: 'be', roles: ['backend'] };
const frontend = { userId: 'fe', roles: ['frontend'] };
const ba = { userId: 'ba', roles: ['ba'] };
const pm = { userId: 'pm', roles: ['pm'] };

describe('chooseExecutor (FR-WORK-02)', () => {
  it('owner_role any has no executor and no fallback', () => {
    expect(chooseExecutor({ ownerRole: 'any', altRoles: [] }, [lead, backend])).toEqual({
      assigneeUserId: null,
      roleCode: null,
      fallbackUsed: false,
    });
  });

  it('one holder of the owner role is the executor', () => {
    expect(
      chooseExecutor({ ownerRole: 'backend', altRoles: [] }, [lead, backend, frontend]),
    ).toEqual({ assigneeUserId: 'be', roleCode: 'backend', fallbackUsed: false });
  });

  it('several holders wait for the lead without a fallback', () => {
    const second = { userId: 'be2', roles: ['backend'] };
    expect(chooseExecutor({ ownerRole: 'backend', altRoles: [] }, [backend, second])).toEqual({
      assigneeUserId: null,
      roleCode: null,
      fallbackUsed: false,
    });
  });

  it('an alternative role stands in when the owner role is absent', () => {
    expect(chooseExecutor({ ownerRole: 'pm', altRoles: ['ba'] }, [lead, ba, backend])).toEqual({
      assigneeUserId: 'ba',
      roleCode: 'ba',
      fallbackUsed: false,
    });
  });

  it('the owner role wins over an alternative role', () => {
    expect(chooseExecutor({ ownerRole: 'pm', altRoles: ['ba'] }, [ba, pm]).assigneeUserId).toBe(
      'pm',
    );
  });

  it('nobody holds the role: the fallback is used and the lead names the executor', () => {
    expect(chooseExecutor({ ownerRole: 'pm', altRoles: ['ba'] }, [lead, backend])).toEqual({
      assigneeUserId: null,
      roleCode: null,
      fallbackUsed: true,
    });
  });
});

describe('stage dates (FR-WORK-12, -18)', () => {
  const opened = new Date('2026-03-01T00:00:00Z');
  const due = stageDueAt(opened, 7);

  it('the due date is the opening plus the duration', () => {
    expect(due.getTime() - opened.getTime()).toBe(7 * DAY);
  });

  it('a running suspension moves the due date of the open stage only', () => {
    const open = { status: 'open', dueAt: due, closedAt: null };
    const closed = { status: 'closed', dueAt: due, closedAt: due };
    expect(effectiveDueAt(open, DAY)?.getTime()).toBe(due.getTime() + DAY);
    expect(effectiveDueAt(closed, DAY)).toEqual(due);
    expect(effectiveDueAt({ status: 'pending', dueAt: null, closedAt: null }, DAY)).toBeNull();
  });

  it('suspension time counts only while the team is suspended', () => {
    const now = new Date('2026-03-05T00:00:00Z');
    const since = new Date('2026-03-03T00:00:00Z');
    expect(ongoingSuspensionMs({ status: 'suspended', suspendedAt: since }, now)).toBe(2 * DAY);
    expect(ongoingSuspensionMs({ status: 'active', suspendedAt: since }, now)).toBe(0);
    expect(ongoingSuspensionMs({ status: 'suspended', suspendedAt: null }, now)).toBe(0);
  });

  it('the open stage is late after its due date or after the planned end of the project', () => {
    const open = { status: 'open', dueAt: due, closedAt: null };
    const before = new Date(due.getTime() - 1);
    const after = new Date(due.getTime() + 1);
    expect(isOverdue(open, due, null, before)).toBe(false);
    expect(isOverdue(open, due, null, after)).toBe(true);
    expect(isOverdue(open, due, new Date(before.getTime() - 1), before)).toBe(true);
  });

  it('a pending stage is never late; a closed one is late when closed after the due date', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    expect(isOverdue({ status: 'pending', dueAt: null, closedAt: null }, null, due, now)).toBe(
      false,
    );
    const late = { status: 'closed', dueAt: due, closedAt: new Date(due.getTime() + DAY) };
    const early = { status: 'closed', dueAt: due, closedAt: new Date(due.getTime() - DAY) };
    expect(isOverdue(late, due, null, now)).toBe(true);
    expect(isOverdue(early, due, null, now)).toBe(false);
  });
});
