import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TwinAccount } from '../fakes/github-app.js';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { ghPerson, github, installApp, link, repoSpec } from '../fixtures/github.js';
import { activeLinkCount, holdingLinkCount, repoLinkRows } from '../fixtures/github-db.js';
import { githubUser, team, type TeamFixture } from '../fixtures/teams.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { startRouteWorld } from '../fixtures/workspace.js';
import type { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * CC-9, the binding of a repository (FR-GH-02, S6-02; architecture 12.2): `INSERT repo_link` under the
 * partial unique index `repo_link_repository_uq` (active or completed), a `23505` by the name of the index
 * becomes 409 REPO_TAKEN. 2 and 20 teams bind one `repository_id` at the same moment -> 1 success, the rest
 * 409 REPO_TAKEN. The teams share one GitHub organization, so one installation (and its repository) is
 * granted to every lead. The teams are in `forming` (the binding is part of preparing the project).
 */

describeInfra('CC-9: one repository, one team (FR-GH-02)', ['db', 'redis'], () => {
  let world: World;
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await startRouteWorld({ github: true });
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  interface Contest {
    teams: TeamFixture[];
    installationId: number;
    repositoryId: number;
  }

  /** `count` teams whose leads co-own one organization; the repository belongs to its single installation. */
  const contest = async (count: number): Promise<Contest> => {
    const teams: TeamFixture[] = [];
    for (let i = 0; i < count; i += 1) {
      teams.push(await team(world, { members: 1, openSeats: 1, status: 'forming' }));
    }
    const owners = await Promise.all(teams.map((t) => ghPerson(world, t.lead)));
    const org: TwinAccount = {
      id: 9_400_000 + Math.floor(Math.random() * 100_000),
      login: `org-${randomUUID().slice(0, 8)}`,
      type: 'Organization',
      ownerIds: owners.map((o) => o.id),
    };
    let installationId = 0;
    for (const [i, t] of teams.entries()) {
      const installed = await installApp(world, t.lead, t.id, {
        account: org,
        ...(i === 0 ? { repos: [repoSpec(owners.slice(0, 2))] } : {}),
      });
      installationId = installed.installation.id;
    }
    const repo = [...github(world).app.repos.values()].find(
      (r) => r.installationId === installationId,
    );
    if (!repo) throw new Error('the organization has no repository');
    return { teams, installationId, repositoryId: repo.id };
  };

  const bind = (c: Contest, index: number, key: string) => {
    const t = c.teams[index];
    if (!t) throw new Error('fixture');
    return link(
      world,
      t.lead,
      t.id,
      { installationId: c.installationId, repositoryId: c.repositoryId },
      key,
    );
  };

  it.each([2, 20])(
    'CC-9: %i teams bind one repository_id at once -> 1 x 200, the rest 409 REPO_TAKEN',
    async (n) => {
      const c = await contest(n);
      const fired = await fireAll(n, (i, key) => bind(c, i, key));
      expect(tally(fired)).toEqual({ 200: 1, 409: n - 1 });
      expect(codesAt(fired, 409)).toEqual(['REPO_TAKEN']);
      expect(await holdingLinkCount(world, c.repositoryId)).toBe(1);
      const winner = winnerOf(fired, 200);
      const winningTeam = c.teams[winner.index];
      expect(winningTeam).toBeDefined();
      for (const [i, t] of c.teams.entries()) {
        expect(await activeLinkCount(world, t.id)).toBe(i === winner.index ? 1 : 0);
        if (i !== winner.index) expect(await repoLinkRows(world, t.id)).toHaveLength(0);
      }
    },
    120_000,
  );

  it('CC-9 (paired): the winner repeats his key -> the stored 200; a loser repeats his key -> the stored 409 REPO_TAKEN; still one link', async () => {
    const c = await contest(5);
    const fired = await fireAll(5, (i, key) => bind(c, i, key));
    const winner = winnerOf(fired, 200);
    const loser = winnerOf(fired, 409);
    expectReplayOf(winner, await bind(c, winner.index, winner.key));
    expectReplayOf(loser, await bind(c, loser.index, loser.key));
    expect(await holdingLinkCount(world, c.repositoryId)).toBe(1);
  }, 120_000);

  it('CC-9: the loser, after the winner unlinks, binds the repository with a fresh key (the index frees it)', async () => {
    const c = await contest(3);
    const fired = await fireAll(3, (i, key) => bind(c, i, key));
    const winner = winnerOf(fired, 200);
    const winningTeam = c.teams[winner.index];
    const loserIndex = fired.findIndex((f) => f.status === 409);
    const losingTeam = c.teams[loserIndex];
    if (!winningTeam || !losingTeam) throw new Error('fixture');
    expect(
      (await world.as(winningTeam.lead).delete(`/v1/teams/${winningTeam.id}/repository`))
        .statusCode,
    ).toBe(204);
    expect((await bind(c, loserIndex, randomUUID())).statusCode).toBe(200);
    expect(await holdingLinkCount(world, c.repositoryId)).toBe(1);
    expect(await activeLinkCount(world, losingTeam.id)).toBe(1);
  }, 120_000);

  it('CC-9: one team binding one repository twice at the same moment keeps one active link (repo_link_team_active_uq)', async () => {
    const c = await contest(1);
    const t = c.teams[0];
    if (!t) throw new Error('fixture');
    const fired = await fireAll(10, (_i, key) => bind(c, 0, key));
    for (const f of fired) expect([200, 409]).toContain(f.status);
    expect(fired.filter((f) => f.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await activeLinkCount(world, t.id)).toBe(1);
    expect(await holdingLinkCount(world, c.repositoryId)).toBe(1);
  }, 120_000);

  it('CC-9: one lead binds two different repositories of his installation to his team at once -> one active link', async () => {
    const c = await contest(1);
    const t = c.teams[0];
    if (!t) throw new Error('fixture');
    const second = github(world).app.addRepo(c.installationId, {
      name: `second-${randomUUID().slice(0, 6)}`,
    });
    const person = await ghPerson(world, t.lead);
    github(world).app.setContributors(second.id, [{ ...person, contributions: 12 }]);
    const ids = [c.repositoryId, second.id];
    const fired = await fireAll(10, (i, key) =>
      link(
        world,
        t.lead,
        t.id,
        { installationId: c.installationId, repositoryId: ids[i % 2] ?? c.repositoryId },
        key,
      ),
    );
    expect(fired.some((f) => f.status === 200)).toBe(true);
    expect(await activeLinkCount(world, t.id)).toBe(1);
  }, 120_000);

  it('CC-9: leads that have no grant cannot take the repository even if they race with the owner', async () => {
    const c = await contest(2);
    const outsiders = await Promise.all([githubUser(world, 'o1'), githubUser(world, 'o2')]);
    const [owner] = c.teams;
    if (!owner) throw new Error('fixture');
    const fired = await fireAll(3, (i, key) => {
      const who = outsiders[i - 1];
      return i === 0
        ? bind(c, 0, key)
        : link(
            world,
            who ?? owner.lead,
            owner.id,
            { installationId: c.installationId, repositoryId: c.repositoryId },
            key,
          );
    });
    expect(fired[0]?.status).toBe(200);
    expect(fired.slice(1).every((f) => f.status === 404)).toBe(true);
  }, 120_000);
});
