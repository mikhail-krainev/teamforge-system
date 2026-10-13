import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { team } from '../../../../test/fixtures/teams.js';
import { invitationRow } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

const DAY_MS = 24 * 3_600_000;

describeInfra('S3 teams: invitation-cleanup (maintenance, C-12)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld();
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  async function insert(
    teamId: string,
    seatId: string,
    leadId: string,
    status: string,
    createdDaysAgo: number,
    expiresInDays: number,
  ): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    await world.sql`
      INSERT INTO teams.invitation (id, team_id, seat_id, token_hash, status, expires_at, created_by, created_at)
      VALUES (${id}, ${teamId}, ${seatId}, ${randomBytes(32)}, ${status},
              ${new Date(now + expiresInDays * DAY_MS)}, ${leadId}, ${new Date(now - createdDaysAgo * DAY_MS)})`;
    return id;
  }

  it('deletes finished invitations older than 30 days, retires overdue active ones, keeps the rest', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const oldUsed = await insert(t.id, seat.id, t.lead.id, 'used', 40, 0);
    const oldRevoked = await insert(t.id, seat.id, t.lead.id, 'revoked', 31, 5);
    const oldExpired = await insert(t.id, seat.id, t.lead.id, 'expired', 35, -28);
    const freshUsed = await insert(t.id, seat.id, t.lead.id, 'used', 5, 2);
    const overdueActive = await insert(t.id, seat.id, t.lead.id, 'active', 10, -3);
    const liveActive = await insert(t.id, seat.id, t.lead.id, 'active', 1, 6);
    const ancientActive = await insert(t.id, seat.id, t.lead.id, 'active', 45, -38);

    await world.runMaintenance('invitation-cleanup');

    expect(await invitationRow(world, oldUsed)).toBeUndefined();
    expect(await invitationRow(world, oldRevoked)).toBeUndefined();
    expect(await invitationRow(world, oldExpired)).toBeUndefined();
    // Overdue for 38 days and created 45 days ago: retired and removed in the same run.
    expect(await invitationRow(world, ancientActive)).toBeUndefined();
    expect((await invitationRow(world, freshUsed))?.status).toBe('used');
    expect((await invitationRow(world, overdueActive))?.status).toBe('expired');
    expect((await invitationRow(world, liveActive))?.status).toBe('active');
  });
});
