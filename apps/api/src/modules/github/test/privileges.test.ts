import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-12: the rights of the application role `tf_app` on the tables of slice 6 (docs/plan.md, "Роли БД":
 * `tf_migrator` owns the schemas, `tf_app` has DML only) and the immutable snapshot of a completed
 * project (CC-13): neither UPDATE nor DELETE of `workspace.project_completion` gets through, even for
 * the application role that holds the DML grant.
 */

const SLICE6_WORKSPACE_TABLES = ['contribution', 'completion_check', 'project_completion'];
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const NOT_FOR_APP = ['TRUNCATE', 'REFERENCES', 'TRIGGER'];

describeInfra('S6 tf_app rights on the tables of slice 6 (S6-12)', ['db'], () => {
  let world: World;
  let app: postgres.Sql;

  beforeAll(async () => {
    world = await World.start();
    app = postgres(world.db.url, { max: 1, prepare: false, onnotice: () => undefined });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    if (!world) return;
    await world.close();
  });

  const tables = async (): Promise<string[]> => {
    const rows = await world.sql<{ name: string }[]>`
      SELECT schemaname || '.' || tablename AS name FROM pg_tables
       WHERE schemaname = 'github'
          OR (schemaname = 'workspace' AND tablename = ANY(${SLICE6_WORKSPACE_TABLES}))
       ORDER BY 1`;
    return rows.map((r) => r.name);
  };

  const privilegeOf = async (table: string, privilege: string): Promise<boolean> => {
    const [row] = await app<{ granted: boolean }[]>`
      SELECT has_table_privilege(current_user, ${table}, ${privilege}) AS granted`;
    return row?.granted === true;
  };

  it('the application connects as tf_app, which is neither a superuser nor an owner', async () => {
    const [role] = await app<{ name: string; rolsuper: boolean }[]>`
      SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(role).toMatchObject({ name: 'tf_app', rolsuper: false });
  });

  it('every table of the github schema and the three workspace tables are covered by the check', async () => {
    const names = await tables();
    expect(names.filter((n) => n.startsWith('workspace.'))).toHaveLength(3);
    expect(names.filter((n) => n.startsWith('github.')).length).toBeGreaterThanOrEqual(9);
  });

  it('tf_app has SELECT, INSERT, UPDATE and DELETE on each of them', async () => {
    for (const table of await tables()) {
      for (const privilege of DML) {
        expect(await privilegeOf(table, privilege), `${privilege} on ${table}`).toBe(true);
      }
    }
  });

  it('tf_app has no TRUNCATE, REFERENCES or TRIGGER on them and does not own them', async () => {
    for (const table of await tables()) {
      for (const privilege of NOT_FOR_APP) {
        expect(await privilegeOf(table, privilege), `${privilege} on ${table}`).toBe(false);
      }
    }
    const [owner] = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_tables
       WHERE (schemaname = 'github' OR (schemaname = 'workspace' AND tablename = ANY(${SLICE6_WORKSPACE_TABLES})))
         AND tableowner = 'tf_app'`;
    expect(owner?.n).toBe(0);
  });

  it('tf_app cannot create or change a table in the github schema', async () => {
    await expect(app.unsafe('CREATE TABLE github.tf_forbidden (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      app.unsafe('ALTER TABLE github.repo_link ADD COLUMN tf_forbidden int'),
    ).rejects.toThrow(/must be owner|permission denied/);
    await expect(app.unsafe('TRUNCATE github.repo_link')).rejects.toThrow(/permission denied/);
    await expect(app.unsafe('DROP TABLE workspace.contribution')).rejects.toThrow(
      /must be owner|permission denied/,
    );
  });

  describe('the snapshot of a completed project is immutable (CC-13)', () => {
    const teamId = randomUUID();
    const userId = randomUUID();

    beforeAll(async () => {
      await app`
        INSERT INTO workspace.project_completion (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
        VALUES (${teamId}, now(), now(), 0, ${app.json({ marker: 'original' })}, ${userId})`;
    });

    const stored = async () => {
      const [row] = await world.sql<
        { overdue_days: number; snapshot: { marker?: string } }[]
      >`SELECT overdue_days, snapshot FROM workspace.project_completion WHERE team_id = ${teamId}`;
      return row;
    };

    it('the application role inserts the row once (the primary key allows a single completion)', async () => {
      await expect(
        app`INSERT INTO workspace.project_completion (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
            VALUES (${teamId}, now(), now(), 0, ${app.json({})}, ${userId})`,
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('UPDATE by the application role is refused, for the snapshot and for the other columns', async () => {
      await expect(
        app`UPDATE workspace.project_completion SET snapshot = ${app.json({ marker: 'changed' })} WHERE team_id = ${teamId}`,
      ).rejects.toThrow(/immutable/);
      await expect(
        app`UPDATE workspace.project_completion SET overdue_days = 7 WHERE team_id = ${teamId}`,
      ).rejects.toThrow(/immutable/);
      await expect(
        app`UPDATE workspace.project_completion SET completed_by = ${randomUUID()} WHERE team_id = ${teamId}`,
      ).rejects.toThrow(/immutable/);
    });

    it('DELETE by the application role is refused', async () => {
      await expect(
        app`DELETE FROM workspace.project_completion WHERE team_id = ${teamId}`,
      ).rejects.toThrow(/immutable|permission denied/);
    });

    it('DELETE and UPDATE by the owner of the schema are refused as well (the trigger, not the grant, holds)', async () => {
      await expect(
        world.sql`DELETE FROM workspace.project_completion WHERE team_id = ${teamId}`,
      ).rejects.toThrow(/immutable/);
      await expect(
        world.sql`UPDATE workspace.project_completion SET snapshot = '{}'::jsonb WHERE team_id = ${teamId}`,
      ).rejects.toThrow(/immutable/);
    });

    it('after all the attempts the row is as it was written', async () => {
      expect(await stored()).toMatchObject({ overdue_days: 0, snapshot: { marker: 'original' } });
    });
  });
});
