import { sql } from 'drizzle-orm';
import type { Database } from '../../../../platform/db/db.module.js';

/**
 * A team that has not started and is pinned to a stub playbook (a playbook without stages) cannot
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
       AND NOT EXISTS (SELECT 1 FROM playbooks.stage AS pinned WHERE pinned.playbook_id = t.playbook_id)
       AND EXISTS (
             SELECT 1 FROM playbooks.playbook AS p
              WHERE p.product_type_code = t.product_type_code
                AND p.status = 'published'
                AND EXISTS (SELECT 1 FROM playbooks.stage AS s WHERE s.playbook_id = p.id))`);
}
