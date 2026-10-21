import { afterAll, beforeAll, expect, it } from 'vitest';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  buildProject,
  completedProject,
  countersOk,
  endCooling,
  finishProject,
  fraudCases,
  markDesired,
  openCaseOf,
  plantHistory,
  type FraudCasePageDto,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  creditRunRow,
  fraudCaseRows,
  fraudSignalRows,
  projectCreditRows,
} from '../../../../test/fixtures/rewards-db.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-03 (written before the implementation): the rules of people and accounts at work in the whole chain - the
 * identity signals of `auth.identity_signal` (SEC-13) reach `fraud_signal` and the queue of the administrator
 * (AF-17, AF-21, AF-22; FR-REW-15; architecture 10.1, 10.5). The unit tests of the rules are in
 * internal/fraud/rules/*.test.ts. The signals are planted with SQL into the real table: they are what the
 * sign-in and the joining write in production (an HMAC of the subnet, the user agent and the device cookie).
 *
 * ASSUMPTIONS: the harness (requests through X-Test-User, no cookie) records no identity signals of its own, so
 * the planted ones are the only ones; AF-22 runs in the phase `cooling_end` and, like every flag, freezes the
 * project that is still `cooling`; "frozen at the end of the cooling" is `credit_run.status = 'frozen'` with an open
 * case and no credit rows.
 */

type Kind = 'ip24' | 'ua' | 'device';

describeInfra(
  'S7 rewards: identity signals reach the anti-fraud (AF-17, AF-21, AF-22, FR-REW-15)',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;

    beforeAll(async () => {
      rw = await startRewardsWorld();
    });

    afterAll(async () => {
      if (rw) await rw.close();
    });

    /** The same HMAC value of `kind` for each of the users, as the sign-in would record it. */
    async function share(kind: Kind, value: string, users: UserFixture[]): Promise<void> {
      const now = clockOf(rw.world).now();
      for (const user of users) {
        await rw.world.sql`
        INSERT INTO auth.identity_signal (user_id, kind, value_hmac, first_seen, last_seen)
        VALUES (${user.id}, ${kind}, ${Buffer.from(value)}, ${now}, ${now})
        ON CONFLICT (user_id, kind, value_hmac) DO UPDATE SET last_seen = EXCLUDED.last_seen`;
      }
    }

    const sharedProject = async (
      kinds: Kind[],
      pick: (p: Project) => UserFixture[],
    ): Promise<Project> => {
      const project = await buildProject(rw.world, {
        beforeCompletion: async (p) => {
          for (const kind of kinds) await share(kind, `shared-${kind}-${p.fx.team.id}`, pick(p));
        },
      });
      await finishProject(project);
      return project;
    };

    const signalOf = async (project: Project, rule: string) =>
      (await fraudSignalRows(rw.world, project.fx.team.id)).find((s) => s.rule_code === rule);

    it('AF-17: two members with one subnet -> the signal is stored with a score; a score below 3 does not freeze the project', async () => {
      const project = await sharedProject(['ip24'], (p) => [p.backend, p.frontend]);
      const signal = await signalOf(project, 'AF-17');
      expect(signal).toMatchObject({ phase: 'completion', action: 'signal' });
      expect(signal?.score).toBeGreaterThanOrEqual(1);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('cooling');
      expect(await fraudCaseRows(rw.world, project.fx.team.id)).toEqual([]);
    }, 300_000);

    it('AF-21: two members with the same subnet, user agent and device (3 features) -> a flag: frozen, one open case', async () => {
      const project = await sharedProject(['ip24', 'ua', 'device'], (p) => [p.backend, p.frontend]);
      expect(await signalOf(project, 'AF-21')).toMatchObject({
        phase: 'completion',
        action: 'flag',
      });
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('frozen');
      expect(await fraudCaseRows(rw.world, project.fx.team.id)).toEqual([
        expect.objectContaining({ status: 'open' }),
      ]);
    }, 300_000);

    it('SEC-13: the administrator sees the rule and the score, never a raw value, a hash or the id of a linked person', async () => {
      const project = await sharedProject(['ip24', 'ua', 'device'], (p) => [p.backend, p.frontend]);
      const response = await fraudCases(rw.world, rw.admin, { status: 'open', limit: 100 });
      const page = expectOk<FraudCasePageDto>('listFraudCases', response, 200);
      const item = page.items.find((c) => c.teamId === project.fx.team.id);
      expect(item?.signals?.map((s) => s.ruleCode)).toContain('AF-21');
      const text = JSON.stringify(item);
      const value = `shared-ip24-${project.fx.team.id}`;
      expect(text).not.toContain(value);
      expect(text).not.toContain(Buffer.from(value).toString('hex'));
      for (const user of [project.backend, project.frontend]) {
        expect(text).not.toContain(user.id);
        expect(text).not.toContain(user.email);
      }
    }, 300_000);

    it('FR-REW-15, C-61: the signals AF-17 (three members, +2) and AF-14 (a fresh mark, +1) add up to 3 -> frozen without any flag', async () => {
      const project = await buildProject(rw.world, {
        beforeCompletion: async (p) => {
          await share('ip24', `three-${p.fx.team.id}`, [p.lead, p.backend, p.frontend]);
          await markDesired(p, 'backend');
        },
      });
      await finishProject(project);
      const signals = await fraudSignalRows(rw.world, project.fx.team.id);
      expect(signals.map((s) => s.rule_code)).toEqual(expect.arrayContaining(['AF-14', 'AF-17']));
      expect(signals.some((s) => s.action === 'flag' || s.action === 'block')).toBe(false);
      const run = await creditRunRow(rw.world, project.fx.team.id);
      expect(run?.fraud_score).toBeGreaterThanOrEqual(3);
      expect(run?.status).toBe('frozen');
      expect((await openCaseOf(rw.world, rw.admin, project.fx.team.id)).teamId).toBe(
        project.fx.team.id,
      );
    }, 300_000);

    it('AF-22, Р-13: with a score of 2 and a second credited project of the same person within 14 days the end of the cooling opens a case instead of crediting', async () => {
      const project = await sharedProject(['ip24'], (p) => [p.lead, p.backend, p.frontend]);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('cooling');
      await plantHistory(rw.world, project.backend, [{ roles: ['backend'], completedDaysAgo: 3 }]);
      await endCooling(project);
      expect(await signalOf(project, 'AF-22')).toMatchObject({
        phase: 'cooling_end',
        action: 'flag',
      });
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('frozen');
      expect(await projectCreditRows(rw.world, project.fx.team.id)).toEqual([]);
      expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(1);
      expect(await fraudCaseRows(rw.world, project.fx.team.id)).toEqual([
        expect.objectContaining({ status: 'open' }),
      ]);
    }, 400_000);

    it('AF-22: a score of 2 and no other credited project of the people in 14 days -> the credit goes through', async () => {
      const project = await sharedProject(['ip24'], (p) => [p.lead, p.backend, p.frontend]);
      await endCooling(project);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('credited');
      expect(await signalOf(project, 'AF-22')).toBeUndefined();
    }, 400_000);

    it('FR-REW-15: a clean project of the same world is not touched by the planted signals of the others', async () => {
      const project = await completedProject(rw.world);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('cooling');
      const signals = await fraudSignalRows(rw.world, project.fx.team.id);
      expect(signals.filter((s) => s.rule_code === 'AF-17' || s.rule_code === 'AF-21')).toEqual([]);
    }, 300_000);
  },
);
