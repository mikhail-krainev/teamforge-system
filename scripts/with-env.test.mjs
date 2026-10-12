import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, parseEnvFile } from './with-env.mjs';

test('with-env: parses KEY=VALUE lines, skips comments', () => {
  const env = parseEnvFile('# comment\nA=1\nB="two words"\n\nC=postgres://u:p@h:1/d\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'postgres://u:p@h:1/d' });
});

test('with-env: parses repeat and command', () => {
  assert.deepEqual(parseArgs(['.env.test', '--repeat', '5', '--', 'pnpm', 'test']), {
    envFile: '.env.test',
    repeat: 5,
    command: ['pnpm', 'test'],
  });
  assert.equal(parseArgs(['.env.test', '--', 'x']).repeat, 1);
});

test('with-env: rejects a missing command or a bad repeat', () => {
  assert.throws(() => parseArgs(['.env.test']));
  assert.throws(() => parseArgs(['.env.test', '--repeat', '0', '--', 'x']));
});
