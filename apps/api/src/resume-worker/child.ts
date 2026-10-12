import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from './parsers.js';
import { KIND_BYTES, type ParseOutcome } from './protocol.js';

/** Whether this process can read the environment of its parent (it must not: other uid, no ptrace). */
function canRead(): boolean {
  try {
    readFileSync(`/proc/${process.ppid}/environ`);
    return true;
  } catch {
    return false;
  }
}

/** Isolation self-test: what uid and environment this process really has (read from /proc). */
function selfCheck(): string {
  // /proc exists on Linux (the container); elsewhere the uid is unknown.
  const status = existsSync('/proc/self/status') ? readFileSync('/proc/self/status', 'utf8') : '';
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1] ?? null;
  const report = { uid, env: Object.keys(process.env), canReadParentEnvironment: canRead() };
  return `${JSON.stringify(report)}\n`;
}

/**
 * One-shot child process (architecture 13.15): reads `<kind byte><file bytes>` from stdin, writes one
 * JSON result to stdout and exits. It runs with an empty environment under its own uid and learns
 * nothing about the queue, the database or the secrets of the parent.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--selfcheck')) {
    process.stdout.write(selfCheck());
    return;
  }
  const input = readFileSync(0);
  const kind = input[0] === KIND_BYTES.docx ? 'docx' : 'pdf';
  let outcome: ParseOutcome;
  try {
    outcome = await parseDocument(kind, input.subarray(1));
  } catch {
    outcome = { v: 1, ok: false, reason: 'CORRUPTED' };
  }
  process.stdout.write(JSON.stringify(outcome));
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
