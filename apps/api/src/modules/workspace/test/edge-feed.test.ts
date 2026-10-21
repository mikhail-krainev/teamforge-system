import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  feed,
  feedAll,
  feedOk,
  linkedTeam,
  type FeedEntryPageDto,
} from '../../../../test/fixtures/completion.js';
import {
  closedIssueDelivered,
  ghPerson,
  mergedPullDelivered,
  waitForContributions,
} from '../../../../test/fixtures/github.js';
import { startRouteWorld, type RouteFixture } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-12, edge cases of the feed (FR-WORK-16): a cursor that belongs to another team or to other filters,
 * pages that end exactly at the limit, entries that share one moment, an empty page. The main cases are
 * in feed.test.ts.
 */

const ENTRIES = 5;

describeInfra('S6 workspace: feed pagination, edge cases (S6-12)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());
  let a: RouteFixture;
  let b: RouteFixture;
  let firstPageOfA: FeedEntryPageDto;

  beforeAll(async () => {
    world = await startRouteWorld({ github: true, clock });
    const first = await linkedTeam(world);
    const second = await linkedTeam(world);
    a = first.fx;
    b = second.fx;
    const person = await ghPerson(world, a.backend);
    // Every entry comes at the very same moment of the test clock: the order inside it is the order of ids.
    for (let i = 0; i < ENTRIES - 1; i += 1) {
      await closedIssueDelivered(world, first.connected.repo, {
        author: person,
        assignees: [person],
        title: `Same moment ${i}`,
      });
    }
    await mergedPullDelivered(world, first.connected.repo, { author: person, title: 'The pull' });
    await waitForContributions(world, a.team.id, ENTRIES);
    const other = await ghPerson(world, b.backend);
    await closedIssueDelivered(world, second.connected.repo, {
      author: other,
      assignees: [other],
      title: 'Of the other team',
    });
    await waitForContributions(world, b.team.id, 1);
    firstPageOfA = await feedOk(world, a.lead, a.team.id, { limit: 2 });
  }, 120_000);

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  it('FR-WORK-16: a cursor made for team A is refused on the feed of team B (400, not a page)', async () => {
    expect(firstPageOfA.nextCursor).toBeTruthy();
    const response = await feed(world, b.lead, b.team.id, {
      cursor: firstPageOfA.nextCursor ?? '',
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('SEC-03: the same cursor on the feed of team A for an outsider is a 404 of the team, never a page', async () => {
    const response = await feed(world, b.lead, a.team.id, {
      cursor: firstPageOfA.nextCursor ?? '',
    });
    expect(response.statusCode).toBe(404);
  });

  it('FR-WORK-16: a cursor made with one filter is refused with another filter, and with none', async () => {
    const filtered = await feedOk(world, a.lead, a.team.id, { limit: 2, source: 'issue' });
    expect(filtered.nextCursor).toBeTruthy();
    const cursor = filtered.nextCursor ?? '';
    expect((await feed(world, a.lead, a.team.id, { cursor, source: 'pr' })).statusCode).toBe(400);
    expect((await feed(world, a.lead, a.team.id, { cursor })).statusCode).toBe(400);
    expect(
      (await feed(world, a.lead, a.team.id, { cursor, userId: a.backend.id, source: 'issue' }))
        .statusCode,
    ).toBe(400);
    expect((await feed(world, a.lead, a.team.id, { cursor, source: 'issue' })).statusCode).toBe(
      200,
    );
  });

  it.each([
    ['text', 'abc'],
    ['a fraction', '1.5'],
    ['a negative number', '-1'],
    ['an empty value', ''],
  ])('FR-WORK-16: limit as %s -> 400', async (_title, limit) => {
    const response = await a.world
      .as(a.lead)
      .get(`/v1/teams/${a.team.id}/feed?limit=${encodeURIComponent(limit)}`);
    expect(response.statusCode, response.body).toBe(400);
  });

  it('FR-WORK-16: a cursor of the correct form with another content (cut, padded or altered) is 400, never a 500', async () => {
    const real = firstPageOfA.nextCursor ?? '';
    for (const cursor of [
      real.slice(0, -3),
      `${real}AAAA`,
      real.split('').reverse().join(''),
      '%00',
      'null',
      '{}',
    ]) {
      const response = await feed(world, a.lead, a.team.id, { cursor });
      expect(response.statusCode, `cursor ${cursor}: ${response.body}`).toBe(400);
    }
  });

  it('FR-WORK-16: entries of one moment are paged one by one without a repeat or a gap', async () => {
    const all = await feedAll(world, a.lead, a.team.id, {}, 1);
    expect(all).toHaveLength(ENTRIES);
    expect(new Set(all.map((e) => e.id)).size).toBe(ENTRIES);
    expect(new Set(all.map((e) => e.receivedAt)).size).toBeLessThan(ENTRIES);
  });

  it('FR-WORK-16: a page that holds exactly the rest has no cursor: there is no empty page behind it', async () => {
    const exact = await feedOk(world, a.lead, a.team.id, { limit: ENTRIES });
    expect(exact.items).toHaveLength(ENTRIES);
    expect(exact.nextCursor).toBeNull();
    const wide = await feedOk(world, a.lead, a.team.id, { limit: 100 });
    expect(wide.items).toHaveLength(ENTRIES);
    expect(wide.nextCursor).toBeNull();
    const oneShort = await feedOk(world, a.lead, a.team.id, { limit: ENTRIES - 1 });
    expect(oneShort.nextCursor).toBeTruthy();
    const last = await feedOk(world, a.lead, a.team.id, {
      limit: ENTRIES - 1,
      cursor: oneShort.nextCursor ?? '',
    });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  it('FR-WORK-16: a cursor used twice gives the same page both times', async () => {
    const page = await feedOk(world, a.lead, a.team.id, { limit: ENTRIES - 1 });
    const cursor = page.nextCursor ?? '';
    const tail = await feedOk(world, a.lead, a.team.id, { limit: 100, cursor });
    expect(tail.items).toHaveLength(1);
    expect(tail.nextCursor).toBeNull();
    const again = await feedOk(world, a.lead, a.team.id, { limit: 100, cursor });
    expect(again).toEqual(tail);
  });

  it('FR-WORK-16: a filter that matches nothing is an empty page with no cursor; so is a filter by a source the team has no entries of', async () => {
    expect(await feedOk(world, a.lead, a.team.id, { source: 'ritual' })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await feedOk(world, b.lead, b.team.id, { source: 'pr' })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('SEC-03: team B sees only its own entry, and an entry of A is never reachable through B with any filter', async () => {
    const own = await feedOk(world, b.lead, b.team.id, { limit: 100 });
    expect(own.items).toHaveLength(1);
    const aboutA = await feedOk(world, b.lead, b.team.id, { userId: a.backend.id });
    expect(aboutA).toEqual({ items: [], nextCursor: null });
  });
});
