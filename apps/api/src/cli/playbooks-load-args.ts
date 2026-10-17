export type PlaybooksLoadArgs =
  { ok: true; files: string[]; publish: boolean } | { ok: false; message: string };

const USAGE = 'usage: playbooks:load <file> [<file> ...] [--publish]';

/**
 * Arguments of `playbooks:load`: one or more files and the only option `--publish`. Anything else (an
 * unknown option, no file) is refused before a connection is opened, so nothing is read or written.
 */
export function parsePlaybooksLoadArgs(argv: readonly string[]): PlaybooksLoadArgs {
  const files: string[] = [];
  let publish = false;
  for (const arg of argv) {
    if (arg === '--publish') publish = true;
    else if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option "${arg.slice(0, 64)}"; ${USAGE}` };
    } else if (arg === '') {
      return { ok: false, message: `an empty file name; ${USAGE}` };
    } else files.push(arg);
  }
  if (files.length === 0) return { ok: false, message: `a file is required; ${USAGE}` };
  return { ok: true, files, publish };
}
