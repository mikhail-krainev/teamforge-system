import { spawn } from 'node:child_process';
import { KIND_BYTES, type ParseOutcome, outcomeSchema } from './protocol.js';

/** Limits of architecture 13.15: 15 s of wall time, 512 KiB of output, 256 MiB of heap. */
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export interface ChildOptions {
  /** Absolute path of `child.js` (or `child.ts` in development, run through tsx). */
  childPath: string;
  /** Uid/gid of the unprivileged child; unset runs it as the parent (development, tests). */
  uid?: number | undefined;
  gid?: number | undefined;
  timeoutMs?: number | undefined;
  /** Extra node flags, e.g. `--frozen-intrinsics` where the parsers allow it. */
  nodeFlags?: string[] | undefined;
}

const failed = (reason: Extract<ParseOutcome, { ok: false }>['reason']): ParseOutcome => ({
  v: 1,
  ok: false,
  reason,
});

function nodeArguments(options: ChildOptions, extra: string[]): string[] {
  return [
    '--max-old-space-size=256',
    '--disallow-code-generation-from-strings',
    ...(options.nodeFlags ?? []),
    ...(options.childPath.endsWith('.ts') ? ['--import', 'tsx'] : []),
    options.childPath,
    ...extra,
  ];
}

interface Verdict {
  timedOut: boolean;
  overflow: boolean;
}

/** Judges the finished child: the signal, the exit code and the output decide the outcome. */
function judge(
  state: Verdict,
  code: number | null,
  signal: NodeJS.Signals | null,
  output: Buffer,
): ParseOutcome {
  if (state.timedOut) return failed('TIMEOUT');
  if (state.overflow) return failed('CORRUPTED');
  // A heap that hit the cap aborts the process (SIGABRT / 134): the file asked for too much.
  if (signal === 'SIGABRT' || code === 134) return failed('LIMIT');
  if (code !== 0) return failed('CORRUPTED');
  try {
    const parsed = outcomeSchema.safeParse(JSON.parse(output.toString('utf8')));
    return parsed.success ? parsed.data : failed('CORRUPTED');
  } catch {
    return failed('CORRUPTED');
  }
}

/** Runs the parser for one file in a fresh child process and returns the checked outcome. */
export function runChild(
  kind: 'pdf' | 'docx',
  bytes: Buffer,
  options: ChildOptions,
): Promise<ParseOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArguments(options, []), {
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
    const chunks: Buffer[] = [];
    const state: Verdict = { timedOut: false, overflow: false };
    let size = 0;
    const timer = setTimeout(() => {
      state.timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        state.overflow = true;
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(failed('CORRUPTED'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(judge(state, code, signal, Buffer.concat(chunks)));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(Buffer.concat([Buffer.from([KIND_BYTES[kind]]), bytes]));
  });
}

/** Isolation check: asks a child (started the same way) for its uid and environment. */
export function selfCheckChild(options: ChildOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArguments(options, ['--selfcheck']), {
      env: {},
      stdio: ['ignore', 'pipe', 'inherit'],
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
