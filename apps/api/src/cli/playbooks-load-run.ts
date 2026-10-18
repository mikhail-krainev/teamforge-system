import { sql } from 'drizzle-orm';
import type { Database } from '../platform/db/db.module.js';
import { PlaybookLoader } from '../modules/playbooks/internal/loader/playbook-loader.js';

/**
 * One file of `playbooks:load` inside the caller's transaction. The role catalog belongs to `profiles`
 * and the pin of a team to `teams`; the operator tool reads and writes them with SQL, the module code
 * never does.
 */
export async function loadPlaybookFile(
  tx: Database,
  text: string,
  options: { uploadedBy: string; publish: boolean; now: Date },
): Promise<Awaited<ReturnType<PlaybookLoader['ensureLoaded']>>> {
  const roles = await tx.execute<{ code: string }>(sql`SELECT code FROM profiles.role`);
  const result = await new PlaybookLoader().ensureLoaded(tx, text, {
    ...options,
    roleCodes: roles.map((row) => row.code),
  });
  // Every successful load repeats it, so a team created on a stub before the real playbooks existed is
  // always moved, whenever they arrive (no one-off migration to miss).
  if (result.playbook.status === 'published') {
    await rebindFormingStubTeams(tx, result.playbook.productTypeCode, options.now);
  }
  return result;
}

/**
 * A team that has not started and is pinned to a stub playbook (no stages, `source_text = 'stub'`) cannot
 * get a route: the start of such a project fails. Moves it to the latest published playbook of its product
 * type that has stages; a started team keeps its version (FR-PLAY-03). Bumps `version` and `updated_at`
 * like every write to a team, so a client holding the old version sees the change.
 */
export async function rebindFormingStubTeams(
  tx: Database,
  productTypeCode: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE teams.team AS t
       SET playbook_id = (
             SELECT p.id
               FROM playbooks.playbook AS p
              WHERE p.product_type_code = t.product_type_code
                AND p.status = 'published'
                AND EXISTS (SELECT 1 FROM playbooks.stage AS s WHERE s.playbook_id = p.id)
              ORDER BY p.v_major DESC, p.v_minor DESC, p.v_patch DESC
              LIMIT 1),
           version = t.version + 1,
           updated_at = ${now.toISOString()}::timestamptz
     WHERE t.status = 'forming'
       AND t.product_type_code = ${productTypeCode}
       AND EXISTS (
             SELECT 1 FROM playbooks.playbook AS stub
              WHERE stub.id = t.playbook_id AND stub.source_text = 'stub')
       AND EXISTS (
             SELECT 1 FROM playbooks.playbook AS p
              WHERE p.product_type_code = t.product_type_code
                AND p.status = 'published'
                AND EXISTS (SELECT 1 FROM playbooks.stage AS s WHERE s.playbook_id = p.id))`);
}
