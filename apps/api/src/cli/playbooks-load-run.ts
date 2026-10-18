import { sql } from 'drizzle-orm';
import type { Database } from '../platform/db/db.module.js';
import { rebindFormingStubTeams } from '../modules/teams/internal/repositories/stub-rebind.js';
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
