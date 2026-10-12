#!/usr/bin/env node
// Runs a command with variables from an env file, optionally several times (flaky/concurrency checks).
// Usage: node scripts/with-env.mjs <env-file> [--repeat N] -- <command> [args...]
// The first failing run stops the loop with its exit code. Variables already set in the environment win.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parses `KEY=VALUE` lines (no interpolation, no quotes handling beyond surrounding quotes). */
export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** Splits argv into [envFile, repeat, command]. */
export function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator < 1 || separator === argv.length - 1) {
    throw new Error('Usage: with-env.mjs <env-file> [--repeat N] -- <command> [args...]');
  }
  const head = argv.slice(0, separator);
  const repeatAt = head.indexOf('--repeat');
  const repeat = repeatAt === -1 ? 1 : Number(head[repeatAt + 1]);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat needs a positive integer');
  return { envFile: head[0], repeat, command: argv.slice(separator + 1) };
}

/**
 * `pnpm` is not always on PATH (corepack shims on Windows): when this script runs under pnpm,
 * re-use the pnpm entry point that started it. No shell is involved, so arguments are not re-parsed.
 */
export function resolveCommand(command, execPath = process.env.npm_execpath) {
  if (command[0] === 'pnpm' && execPath) {
    const rest = command.slice(1);
    return /\.[cm]?js$/.test(execPath) ? [process.execPath, [execPath, ...rest]] : [execPath, rest];
  }
  return [command[0], command.slice(1)];
}

function main() {
  const { envFile, repeat, command } = parseArgs(process.argv.slice(2));
  const file = path.resolve(root, envFile);
  if (!existsSync(file)) throw new Error(`Env file not found: ${file}`);
  const env = { ...parseEnvFile(readFileSync(file, 'utf8')), ...process.env };
  for (let run = 1; run <= repeat; run += 1) {
    if (repeat > 1) console.log(`\n[with-env] run ${run}/${repeat}: ${command.join(' ')}`);
    const [file, args] = resolveCommand(command);
    const result = spawnSync(file, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
