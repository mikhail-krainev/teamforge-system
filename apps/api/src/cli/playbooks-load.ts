import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadMigrateConfigOrExit } from '../platform/config/config.js';
import type { Database } from '../platform/db/db.module.js';
import { DomainError } from '../platform/errors/domain-error.js';
import { parsePlaybooksLoadArgs } from './playbooks-load-args.js';
import { loadPlaybookFile } from './playbooks-load-run.js';

/** `uploaded_by` of a playbook loaded from the command line: nobody signed in (the id of the seeded stubs). */
const OPERATOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Loads playbook files into the database (FR-PLAY-05, architecture 11.1):
 * `node dist/cli/playbooks-load.js <file> [<file> ...] [--publish]` (dev: `pnpm --filter api run playbooks:load`).
 * It runs the very same loader as `POST /v1/admin/playbooks`, over the DIRECT connection of the owner role,
 * without the HTTP application, so the `migrate` container can seed the first playbooks. Loading the same
 * file again changes nothing (the SHA-256 is compared), so the seed is safe to run on every start. After a
 * published playbook, teams still forming on a stub playbook are moved to it (`loadPlaybookFile`).
 * One JSON line per file; exit code 0 on success, 2 for bad arguments, 1 otherwise (errors[] of a
 * rejected file are printed as JSON on stderr).
 */
async function main(): Promise<void> {
  const parsed = parsePlaybooksLoadArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    process.exit(2);
  }
  const { DATABASE_DIRECT_URL } = loadMigrateConfigOrExit(process.env);
  const client = postgres(DATABASE_DIRECT_URL, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    for (const file of parsed.files) {
      const text = await readFile(file, 'utf8');
      const result = await drizzle(client).transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        return loadPlaybookFile(tx, text, {
          uploadedBy: OPERATOR_ID,
          publish: parsed.publish,
          now: new Date(),
        });
      });
      process.stdout.write(
        `${JSON.stringify({
          file,
          outcome: result.outcome,
          id: result.playbook.id,
          productType: result.playbook.productTypeCode,
          version: result.playbook.version,
          status: result.playbook.status,
          warnings: result.warnings,
        })}\n`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    if (error instanceof DomainError) {
      process.stderr.write(
        `playbooks:load refused: ${error.code} ${JSON.stringify({ detail: error.data.detail, errors: error.data.errors })}\n`,
      );
    } else {
      process.stderr.write(
        `playbooks:load failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
      );
    }
    process.exit(1);
  },
);
